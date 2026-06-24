/** Re-grounding — mitigates the "state drift" failure mode: over a long
 * multi-turn conversation full of tool results, small models drift
 * off-distribution and start ignoring their original system instructions.
 *
 * Stateless, like the loop-breaker ([[loop.ts]]): the signal is read entirely
 * from the inbound request. When the history has accumulated enough tool
 * results, foxfence re-asserts the original system prompt near the end of the
 * request so the constraint is back in the model's recent attention. It only
 * ever *adds* a reminder — it never drops or rewrites existing turns. */

export interface DriftDetection {
  /** Number of tool-result messages in the history (the drift proxy). */
  toolResults: number;
  /** The original system instructions to re-assert. */
  systemContent: string;
}

/** Reads the first system message's text, tolerating multipart content. */
function firstSystemText(messages: Array<unknown>): string {
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue;
    const mm = m as Record<string, unknown>;
    if (mm.role !== "system") continue;
    if (typeof mm.content === "string") return mm.content;
    if (Array.isArray(mm.content)) {
      const text = mm.content
        .map((p) => (p !== null && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, unknown>).text : ""))
        .filter(Boolean)
        .join("");
      if (text) return text as string;
    }
    return ""; // a system message with non-text content — nothing to re-assert
  }
  return "";
}

/** Detects drift risk: a system prompt exists and the history carries at least
 * `afterToolResults` tool-result messages. Returns null otherwise. */
export function detectStateDrift(
  messages: unknown,
  afterToolResults: number,
): DriftDetection | null {
  if (!Array.isArray(messages) || afterToolResults < 1) return null;
  const systemContent = firstSystemText(messages);
  if (!systemContent) return null;
  let toolResults = 0;
  for (const m of messages) {
    if (m !== null && typeof m === "object" && (m as Record<string, unknown>).role === "tool") {
      toolResults++;
    }
  }
  if (toolResults < afterToolResults) return null;
  return { toolResults, systemContent };
}

/** The re-grounding reminder appended to the outbound request. Truncates the
 * re-asserted instructions to `maxChars` so a huge system prompt can't blow the
 * token budget. */
export function regroundReminder(d: DriftDetection, maxChars: number): Record<string, unknown> {
  const text =
    d.systemContent.length > maxChars ? `${d.systemContent.slice(0, maxChars)}…` : d.systemContent;
  return {
    role: "system",
    content: `Reminder — your original instructions are still in effect; keep following them:\n${text}`,
  };
}
