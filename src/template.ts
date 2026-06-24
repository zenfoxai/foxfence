/** Template hygiene — mitigates the "chat-template sensitivity" failure mode of
 * small models. Many small/self-hosted models apply a strict chat template
 * (ChatML, Llama-3, Gemma…) that rejects a `system` role, rejects the `tool`
 * role, or breaks on consecutive same-role turns — and when the template is
 * violated, output quality collapses.
 *
 * The json-prompted shim already reshapes history for the models it drives; this
 * module covers the gap on the *native / passthrough* path, where foxfence
 * otherwise forwards messages untouched. It is driven entirely by a profile's
 * `chatTemplateQuirks`, so it only acts when you've declared a quirk — and it is
 * a pure transform (returns a new array, mutates nothing).
 */

type Msg = Record<string, unknown>;

/** Quirks this transform knows how to act on (others are ignored here). */
export const SUPPORTED_QUIRKS = ["no-system-role", "no-tool-role", "merge-consecutive"] as const;

/** Flattens string or OpenAI multipart content to plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p !== null && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string"
          ? ((p as Record<string, unknown>).text as string)
          : "",
      )
      .filter(Boolean)
      .join("");
  }
  return "";
}

/** Folds every system message into the first user turn (or a new leading user
 * turn) — for templates that reject the system role (e.g. Gemma). */
function foldSystem(msgs: Msg[]): Msg[] {
  const system = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).filter(Boolean);
  if (system.length === 0) return msgs;
  const rest = msgs.filter((m) => m.role !== "system");
  const preface = system.join("\n\n");
  const firstUser = rest.findIndex((m) => m.role === "user");
  if (firstUser === -1) return [{ role: "user", content: preface }, ...rest];
  rest[firstUser] = { ...rest[firstUser], content: `${preface}\n\n${textOf(rest[firstUser]!.content)}` };
  return rest;
}

/** Rewrites `tool` messages as user turns — for templates with no tool role. */
function foldToolRole(msgs: Msg[]): Msg[] {
  return msgs.map((m) => (m.role === "tool" ? { role: "user", content: `Tool result: ${textOf(m.content)}` } : m));
}

/** Coalesces adjacent same-role turns — for strict-alternation templates.
 * Only merges plain-text turns; an assistant turn carrying `tool_calls` is left
 * intact so a call is never destroyed. */
function mergeConsecutive(msgs: Msg[]): Msg[] {
  const mergeable = (m: Msg | undefined): m is Msg =>
    !!m && typeof m.content === "string" && !("tool_calls" in m);
  const out: Msg[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && mergeable(prev) && mergeable(m)) {
      prev.content = `${prev.content as string}\n\n${m.content as string}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/** Applies the supported quirks, in a fixed order, to a copy of the messages.
 * Returns the same array reference semantics aside, a no-op when no supported
 * quirk is present. */
export function applyTemplateQuirks(messages: Msg[], quirks: string[]): Msg[] {
  let msgs = messages.map((m) => ({ ...m }));
  if (quirks.includes("no-system-role")) msgs = foldSystem(msgs);
  if (quirks.includes("no-tool-role")) msgs = foldToolRole(msgs);
  if (quirks.includes("merge-consecutive")) msgs = mergeConsecutive(msgs);
  return msgs;
}

/** The supported quirks present in a profile's list (what we'll actually act on). */
export function appliedQuirks(quirks: string[]): string[] {
  return quirks.filter((q) => (SUPPORTED_QUIRKS as readonly string[]).includes(q));
}
