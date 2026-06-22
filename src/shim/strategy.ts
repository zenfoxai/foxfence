/** Tool-calling shim interfaces (spec §4, §6). */

export interface ModelCapabilities {
  toolCalling: "native" | "weak" | "none";
  parallelToolCalls: boolean;
  jsonMode: "native" | "prompted" | "none";
  source: "probe" | "profile" | "runtime-downgrade" | "pinned" | "assumed";
}

export interface ToolFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolDef {
  type: "function";
  function: ToolFunctionDef;
}

export type Msg = Record<string, unknown>;

/** Extracts well-formed tool definitions from a loose request body. */
export function getTools(body: Record<string, unknown>): ToolDef[] {
  if (!Array.isArray(body.tools)) return [];
  const tools: ToolDef[] = [];
  for (const t of body.tools) {
    if (t === null || typeof t !== "object") continue;
    const fn = (t as Record<string, unknown>).function;
    if (fn === null || typeof fn !== "object") continue;
    const f = fn as Record<string, unknown>;
    if (typeof f.name !== "string") continue;
    tools.push({
      type: "function",
      function: {
        name: f.name,
        description: typeof f.description === "string" ? f.description : undefined,
        parameters:
          f.parameters !== null && typeof f.parameters === "object"
            ? (f.parameters as Record<string, unknown>)
            : undefined,
      },
    });
  }
  return tools;
}

export type DecodeResult =
  | { ok: true; message: Msg; finishReason: "tool_calls" | "stop" }
  | { ok: false; error: string; repairHint: string };

/** A shim strategy transforms the request for the upstream and parses the
 * raw model output back into clean OpenAI tool calls (§6.2). */
export interface ToolShimStrategy {
  name: "native" | "json-prompted" | "constrained" | "react";
  /** Builds the upstream request. Must not mutate `body`. */
  encode(body: Record<string, unknown>): Record<string, unknown>;
  /** Parses the upstream response body. */
  decode(upstreamBody: Record<string, unknown>, original: Record<string, unknown>): DecodeResult;
  /** Messages to append for a repair attempt (§6.4). */
  repairTurn(upstreamBody: Record<string, unknown>, repairHint: string): Msg[];
}
