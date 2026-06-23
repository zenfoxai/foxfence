/** Loop-breaker — mitigates the "infinite retry loop" failure mode of small /
 * self-hosted models: when a tool call fails, the model often re-emits the
 * *identical* call instead of adapting, and the agent loop spins forever.
 *
 * The signal is read entirely from the inbound request's message history, so
 * this respects the stateless design principle (§2.1): nothing is remembered
 * between requests. A request whose recent assistant turns are the same tool
 * call, repeated `threshold` times, is a stuck loop. */

export interface LoopDetection {
  /** The repeated tool name (last call in the run; for parallel calls, the
   * first of the repeated signature). */
  tool: string;
  /** Canonical form of the repeated arguments — what to tell the model not to
   * send again. */
  arguments: string;
  /** Length of the trailing run of identical calls. */
  count: number;
}

/** Recursively sorts object keys so {a,b} and {b,a} canonicalize equal. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}

/** Canonicalize tool-call arguments so formatting / key-order differences
 * don't hide a repeat. Falls back to the trimmed raw string for non-JSON. */
function canonicalArgs(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)));
  } catch {
    return raw.trim();
  }
}

/** A stable signature for one assistant turn's tool call(s): the sorted set of
 * `name(args)` so a parallel-call turn also compares structurally. Returns
 * null for an assistant turn that carries no tool calls. */
function callSignature(
  m: Record<string, unknown>,
): { sig: string; tool: string; args: string } | null {
  const calls = m.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const parts: Array<{ key: string; tool: string; args: string }> = [];
  for (const c of calls) {
    const fn = ((c as Record<string, unknown>)?.function ?? {}) as Record<string, unknown>;
    const tool = typeof fn.name === "string" ? fn.name : "";
    const args = canonicalArgs(fn.arguments);
    parts.push({ key: `${tool}(${args})`, tool, args });
  }
  parts.sort((a, b) => a.key.localeCompare(b.key));
  return { sig: parts.map((p) => p.key).join("|"), tool: parts[0]!.tool, args: parts[0]!.args };
}

/** Detects a stuck retry loop: `threshold` or more consecutive assistant
 * tool-call turns (most recent first) carrying the identical call signature.
 * Plain assistant turns and tool/user turns in between are ignored — only the
 * run of identical *tool-call* turns at the tail matters. */
export function detectToolCallLoop(
  messages: unknown,
  threshold: number,
): LoopDetection | null {
  if (!Array.isArray(messages) || threshold < 2) return null;

  let runSig: string | null = null;
  let count = 0;
  let tool = "";
  let args = "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === null || typeof m !== "object") continue;
    const mm = m as Record<string, unknown>;
    if (mm.role !== "assistant") continue;
    const signature = callSignature(mm);
    if (signature === null) continue; // assistant turn without tool calls
    if (runSig === null) {
      runSig = signature.sig;
      tool = signature.tool;
      args = signature.args;
      count = 1;
    } else if (signature.sig === runSig) {
      count++;
    } else {
      break; // run ended — a different call before the repeated tail
    }
  }

  if (runSig === null || count < threshold) return null;
  return { tool, arguments: args, count };
}

/** The corrective nudge appended to the outbound request (action: "nudge").
 * A system message keeps it clearly out-of-band; small models weight a late
 * instruction heavily, which is what we want here. */
export function loopBreakerNudge(d: LoopDetection): Record<string, unknown> {
  return {
    role: "system",
    content:
      `Notice: the tool \`${d.tool}\` has already been called ${d.count} times in a row ` +
      `with identical arguments (${d.arguments}) and it has not resolved the task. ` +
      `Do not call it again the same way. Choose one of: ` +
      `(1) call it with corrected arguments, ` +
      `(2) use a different tool, or ` +
      `(3) stop and explain to the user what is blocking you.`,
  };
}

/** A deterministic completion that breaks the loop without another upstream
 * call (action: "break"). Shaped like any other OpenAI chat.completion so the
 * agent recovers in-band. */
export function loopBreakResponse(model: string, d: LoopDetection): Record<string, unknown> {
  return {
    id: `chatcmpl-fox-loop-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            `Stopping: the tool \`${d.tool}\` was called ${d.count} times with identical ` +
            `arguments without resolving the task. foxfence broke the retry loop. ` +
            `Adjust the approach or provide more information to continue.`,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    foxfence: { loop: { tool: d.tool, count: d.count, action: "break" } },
  };
}
