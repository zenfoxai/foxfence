import type { EvalCase } from "./corpus.ts";

/**
 * A deterministic, corpus-aware *simulated weak model* for a self-contained,
 * reproducible `bun run eval` (no GPU needed). It models a model with NO
 * native tool calling: it never emits OpenAI `tool_calls`, only text. For a
 * tool_call case it writes the intended call as JSON-in-text (often fenced,
 * sometimes malformed); for a no_call case it answers in prose.
 *
 * The point of the eval is the DELTA: called directly, this model scores ~0%
 * on tool_call cases (the agent gets unusable text); behind foxfence, the
 * json-prompted shim + repair loop recover the calls. Real-model numbers come
 * from `bun run eval --endpoint …`.
 *
 * It is corpus-aware (it looks the case up by the preserved user message) so
 * the "intent" is correct — this measures FORMAT recovery, not the model's
 * reasoning, which is the honest thing a simulator can demonstrate.
 */
export interface SimModel {
  baseUrl: string;
  requests: number;
  stop(): void;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fills required args missing from the partial expectation with a
 * type-appropriate default, so the simulated call is schema-valid. */
function synthesizeArgs(c: EvalCase): Record<string, unknown> {
  if (c.expect.type !== "tool_call") return {};
  const expect = c.expect;
  const tool = c.tools.find((t) => t.function.name === expect.name);
  const params = tool?.function.parameters ?? {};
  const props = (params.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(params.required) ? (params.required as string[]) : [];
  const args: Record<string, unknown> = { ...(expect.args ?? {}) };
  for (const key of required) {
    if (key in args) continue;
    const schema = props[key] ?? {};
    args[key] = defaultForSchema(schema);
  }
  return args;
}

function defaultForSchema(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "unspecified";
  }
}

/** The five deterministic "pathologies" a weak model exhibits, keyed by case
 * id so a run is reproducible. Buckets 0-2 are recoverable on the first try,
 * 3 needs one repair, 4 is unrecoverable (so foxfence never scores a fake
 * 100%). `repair` is true when the request already carries a repair turn. */
function weakToolText(c: EvalCase, repair: boolean): string {
  const args = synthesizeArgs(c);
  const callJson = JSON.stringify({ tool_call: { name: (c.expect as { name: string }).name, arguments: args } });
  const bucket = hash(c.id) % 5;
  if (repair) return callJson; // a model that fixes itself when told the error
  switch (bucket) {
    case 0:
      return callJson;
    case 1:
      return "```json\n" + callJson + "\n```";
    case 2:
      return `Sure, I'll do that.\n${callJson}`;
    case 3:
      return callJson.slice(0, callJson.length - 3); // truncated → needs repair
    default:
      return `I think I should call ${(c.expect as { name: string }).name}, but I'm not sure how.`;
  }
}

function looksLikeRepair(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1) as Record<string, unknown> | undefined;
  const content = typeof last?.content === "string" ? last.content : "";
  return /invalid|corrected/i.test(content);
}

/** Finds the case whose user message appears in this request (the user text
 * survives the json-prompted shim's transforms verbatim). */
function findCase(body: Record<string, unknown>, byUser: Array<{ text: string; case: EvalCase }>): EvalCase | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const haystack = messages
    .map((m) => (typeof (m as Record<string, unknown>).content === "string" ? (m as Record<string, unknown>).content : ""))
    .join("\n");
  // longest user text first, so a short message can't shadow a longer match
  for (const entry of byUser) {
    if (haystack.includes(entry.text)) return entry.case;
  }
  return null;
}

function completion(content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-sim",
    object: "chat.completion",
    created: 1700000000,
    model: "sim-weak",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

export function startSimModel(cases: EvalCase[]): SimModel {
  const byUser = cases
    .map((c) => ({ text: String(c.messages[0]?.content ?? ""), case: c }))
    .sort((a, b) => b.text.length - a.text.length);
  const state = { requests: 0 };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      state.requests++;

      const c = findCase(body, byUser);
      // Unmatched (e.g. the capability probe) → plain text, which foxfence
      // classifies as a non-native model and routes to the json-prompted shim.
      if (!c) return Response.json(completion("ok"));
      if (c.expect.type === "no_call") {
        return Response.json(completion("I can answer that directly without any tools."));
      }
      return Response.json(completion(weakToolText(c, looksLikeRepair(body))));
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    get requests() {
      return state.requests;
    },
    stop: () => server.stop(true),
  };
}
