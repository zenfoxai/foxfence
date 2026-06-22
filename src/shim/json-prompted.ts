import type { DecodeResult, Msg, ToolDef, ToolShimStrategy } from "./strategy.ts";
import { getTools } from "./strategy.ts";
import { validateAgainstSchema } from "./args-validate.ts";

/** `json-prompted` strategy (§6.2 #3, §6.3): tools are described in an
 * injected system block; the model is mandated to answer with a single JSON
 * object; output parsing is tolerant. */

const MAX_DESCRIPTION_CHARS = 400;

function describeTool(tool: ToolDef): string {
  const { name, description, parameters } = tool.function;
  let desc = (description ?? "").replace(/\s+/g, " ").trim();
  if (desc.length > MAX_DESCRIPTION_CHARS) desc = desc.slice(0, MAX_DESCRIPTION_CHARS) + "…";
  const schema = parameters ? JSON.stringify(parameters) : "{}";
  return `- ${name}: ${desc}\n  parameters schema: ${schema}`;
}

export function buildToolSystemBlock(body: Record<string, unknown>): string {
  const tools = getTools(body);
  const lines = [
    "You have access to the following tools. To call a tool, reply ONLY with",
    "a single JSON object of the form:",
    '{"tool_call": {"name": "<tool name>", "arguments": {<arguments object>}}}',
    "To answer the user directly without calling a tool, reply ONLY with:",
    '{"final": "<your answer>"}',
    "Never wrap the JSON in prose or code fences. Never invent tool names.",
    "",
    "Available tools:",
    ...tools.map(describeTool),
  ];

  const choice = body.tool_choice;
  if (choice === "required") {
    lines.push("", "You MUST call one of the tools now (a tool_call reply is mandatory).");
  } else if (choice !== null && typeof choice === "object") {
    const forced = ((choice as Record<string, unknown>).function as Record<string, unknown>)?.name;
    if (typeof forced === "string") {
      lines.push("", `You MUST call the tool "${forced}" now (a tool_call reply is mandatory).`);
    }
  }
  return lines.join("\n");
}

/** Models with no native tool support also reject `tool` role messages and
 * assistant `tool_calls`. The history is rewritten into the same textual
 * protocol the model is asked to speak. */
export function transformHistory(messages: Msg[]): Msg[] {
  const callNames = new Map<string, string>(); // tool_call_id → tool name
  const out: Msg[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      const calls = (message.tool_calls as Array<Record<string, unknown>>).map((call) => {
        const fn = (call.function ?? {}) as Record<string, unknown>;
        if (typeof call.id === "string" && typeof fn.name === "string") {
          callNames.set(call.id, fn.name);
        }
        return JSON.stringify({
          tool_call: { name: fn.name, arguments: safeParse(fn.arguments) },
        });
      });
      const prefix = typeof message.content === "string" && message.content ? `${message.content}\n` : "";
      out.push({ role: "assistant", content: prefix + calls.join("\n") });
    } else if (role === "tool") {
      const name = typeof message.tool_call_id === "string"
        ? (callNames.get(message.tool_call_id) ?? "unknown")
        : "unknown";
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      out.push({ role: "user", content: `Tool result for "${name}":\n${content}` });
    } else {
      out.push(message);
    }
  }
  return out;
}

function safeParse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Tolerant extraction of the first plausible JSON object from raw model
 * output: strict parse, then fenced blocks, then a string-aware balanced
 * brace scan. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [raw.trim()];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (m[1]) candidates.push(m[1].trim());
  }
  for (const source of [...candidates]) {
    let from = 0;
    for (let starts = 0; starts < 8; starts++) {
      const open = source.indexOf("{", from);
      if (open === -1) break;
      const balanced = scanBalanced(source, open);
      if (balanced !== null) candidates.push(balanced);
      from = open + 1;
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function scanBalanced(source: string, open: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < source.length && i < open + 100_000; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

let callCounter = 0;
function newCallId(): string {
  return `call_fox_${(++callCounter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Validates a parsed {name, arguments} pair against the declared tools and
 * converts it to OpenAI tool_call format. Returns an error string on
 * failure. Shared with the react strategy. */
export function toToolCall(
  name: unknown,
  args: unknown,
  tools: ToolDef[],
): { call: Msg } | { error: string } {
  if (typeof name !== "string" || name.length === 0) {
    return { error: "tool_call.name is missing or not a string" };
  }
  const tool = tools.find((t) => t.function.name === name);
  if (!tool) {
    const known = tools.map((t) => t.function.name).join(", ");
    return { error: `unknown tool "${name}" (available: ${known})` };
  }
  let parsedArgs = safeParse(args ?? {});
  if (typeof parsedArgs === "string") {
    return { error: `arguments for "${name}" are not valid JSON` };
  }
  if (parsedArgs === null || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
    return { error: `arguments for "${name}" must be a JSON object` };
  }
  if (tool.function.parameters) {
    const errors = validateAgainstSchema(parsedArgs, tool.function.parameters);
    if (errors.length > 0) {
      return { error: `invalid arguments for "${name}": ${errors.join("; ")}` };
    }
  }
  return {
    call: {
      id: newCallId(),
      type: "function",
      function: { name, arguments: JSON.stringify(parsedArgs) },
    },
  };
}

export interface JsonPromptedOptions {
  /** Chat-template quirk (§6.1): the model rejects the system role, so the
   * tool block is carried on a user message instead. */
  noSystemRole?: boolean;
}

/** Places the injected tool block per the model's chat-template quirks. */
export function injectToolBlock(messages: Msg[], systemBlock: string, noSystemRole: boolean): Msg[] {
  if (noSystemRole) {
    // Merge into the first user message, else prepend a user message; never
    // emit a system role.
    const firstUser = messages.findIndex((m) => m.role === "user");
    if (firstUser !== -1 && typeof messages[firstUser]!.content === "string") {
      messages[firstUser] = {
        ...messages[firstUser]!,
        content: `${systemBlock}\n\n${messages[firstUser]!.content as string}`,
      };
    } else {
      messages.unshift({ role: "user", content: systemBlock });
    }
    return messages;
  }
  const first = messages[0];
  if (first && first.role === "system" && typeof first.content === "string") {
    messages[0] = { ...first, content: `${first.content}\n\n${systemBlock}` };
  } else {
    messages.unshift({ role: "system", content: systemBlock });
  }
  return messages;
}

export function createJsonPromptedStrategy(opts: JsonPromptedOptions = {}): ToolShimStrategy {
  return {
    name: "json-prompted",

    encode(body) {
      const systemBlock = buildToolSystemBlock(body);
      const original = Array.isArray(body.messages) ? (body.messages as Msg[]) : [];
      const messages = injectToolBlock(transformHistory(original), systemBlock, opts.noSystemRole ?? false);
      const {
        tools: _tools,
        tool_choice: _choice,
        parallel_tool_calls: _parallel,
        ...rest
      } = body;
      return { ...rest, messages, stream: false };
    },

    decode(upstreamBody, original): DecodeResult {
      const tools = getTools(original);
      const message = (upstreamBody.choices as Array<Record<string, unknown>> | undefined)?.[0]
        ?.message as Record<string, unknown> | undefined;

      // a model that answers with native tool_calls despite the shim is fine
      // — validate and accept.
      if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return decodeNativeCalls(message, tools);
      }

      const content = typeof message?.content === "string" ? message.content : "";
      if (content.trim().length === 0) {
        return { ok: false, error: "empty reply", repairHint: "Your reply was empty." };
      }

      const choice = original.tool_choice;
      const toolDemanded =
        choice === "required" || (choice !== null && typeof choice === "object");

      const parsed = extractJsonObject(content);
      if (parsed === null) {
        if (toolDemanded) {
          return {
            ok: false,
            error: "tool call demanded but the model answered with plain text",
            repairHint:
              'You must call a tool. Reply ONLY with {"tool_call": {"name": ..., "arguments": {...}}}.',
          };
        }
        // text that *attempted* the protocol (e.g. a truncated tool_call)
        // must be repaired, not leaked to the agent as a final answer
        if (/"(?:tool_call|final)"\s*:/.test(content)) {
          return {
            ok: false,
            error: "reply looks like a protocol object but is not valid JSON",
            repairHint: "Your JSON is invalid (truncated or malformed). Return only the corrected object.",
          };
        }
        // no JSON anywhere: treat the text as a final answer rather than
        // punishing a model for answering plainly when no tool was needed
        return {
          ok: true,
          message: { role: "assistant", content: content.trim() },
          finishReason: "stop",
        };
      }

      if (typeof parsed.final === "string") {
        if (toolDemanded) {
          return {
            ok: false,
            error: "tool call demanded but the model gave a final answer",
            repairHint:
              'You must call a tool. Reply ONLY with {"tool_call": {"name": ..., "arguments": {...}}}.',
          };
        }
        return {
          ok: true,
          message: { role: "assistant", content: parsed.final },
          finishReason: "stop",
        };
      }

      // accepted shapes: {tool_call: {name, arguments}} or bare {name, arguments}
      const callObj =
        parsed.tool_call !== null && typeof parsed.tool_call === "object"
          ? (parsed.tool_call as Record<string, unknown>)
          : typeof parsed.name === "string"
            ? parsed
            : null;
      if (callObj === null) {
        return {
          ok: false,
          error: "JSON object is neither a tool_call nor a final answer",
          repairHint:
            'Your JSON must be either {"tool_call": {"name": ..., "arguments": {...}}} or {"final": "..."}.',
        };
      }
      const result = toToolCall(callObj.name, callObj.arguments, tools);
      if ("error" in result) {
        return { ok: false, error: result.error, repairHint: result.error };
      }
      return {
        ok: true,
        message: { role: "assistant", content: null, tool_calls: [result.call] },
        finishReason: "tool_calls",
      };
    },

    repairTurn(upstreamBody, repairHint) {
      const message = (upstreamBody.choices as Array<Record<string, unknown>> | undefined)?.[0]
        ?.message as Record<string, unknown> | undefined;
      const raw = typeof message?.content === "string" ? message.content : JSON.stringify(message ?? {});
      return [
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `Your reply was invalid: ${repairHint}\nReply ONLY with the corrected JSON object, nothing else.`,
        },
      ];
    },
  };
}

/** Shared with the native strategy: validate tool_calls already in OpenAI
 * format (§6.4: arguments are validated before returning to the agent). */
export function decodeNativeCalls(message: Record<string, unknown>, tools: ToolDef[]): DecodeResult {
  const calls = message.tool_calls as Array<Record<string, unknown>>;
  const validated: Msg[] = [];
  for (const call of calls) {
    const fn = (call.function ?? {}) as Record<string, unknown>;
    const result = toToolCall(fn.name, fn.arguments, tools);
    if ("error" in result) {
      return { ok: false, error: result.error, repairHint: result.error };
    }
    // keep the upstream's call id when present
    if (typeof call.id === "string" && call.id.length > 0) {
      (result.call as Record<string, unknown>).id = call.id;
    }
    validated.push(result.call);
  }
  return {
    ok: true,
    message: {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      tool_calls: validated,
    },
    finishReason: "tool_calls",
  };
}
