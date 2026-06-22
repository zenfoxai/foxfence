import type { ModelRoute, Upstream } from "../config/schema.ts";
import { callUpstream } from "../upstream/client.ts";
import type { Msg, ToolShimStrategy } from "./strategy.ts";

/** The bounded repair loop (§6.4) — the single exception to "one call = one
 * turn": bounded, accounted for, visible, and disableable
 * (repair.max_attempts: 0). */

export interface ShimUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ShimRunResult {
  /** Final OpenAI chat.completion body — on parse failure, a completion
   * with finish_reason "error" and foxfence.parse_error. */
  body: Record<string, unknown>;
  repairs: number;
  parseError?: string;
  /** Raw non-OK upstream response relayed verbatim instead of a body. */
  upstreamErrorResponse?: Response;
}

function accumulate(total: ShimUsage, usage: unknown): void {
  if (usage === null || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  total.prompt_tokens += typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  total.completion_tokens += typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  total.total_tokens += typeof u.total_tokens === "number" ? u.total_tokens : 0;
}

export async function runToolShim(
  body: Record<string, unknown>,
  route: ModelRoute,
  upstream: Upstream,
  strategy: ToolShimStrategy,
  maxAttempts: number,
): Promise<ShimRunResult> {
  const encoded = strategy.encode(body);
  let messages = [...(encoded.messages as Msg[])];
  const usage: ShimUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let lastError = "no attempt made";
  let lastUpstreamBody: Record<string, unknown> | null = null;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const response = await callUpstream({ ...encoded, messages }, route, upstream);
    if (!response.ok) {
      return { body: {}, repairs: attempt, upstreamErrorResponse: response };
    }
    let upstreamBody: Record<string, unknown>;
    try {
      upstreamBody = (await response.json()) as Record<string, unknown>;
    } catch {
      return {
        body: {},
        repairs: attempt,
        upstreamErrorResponse: new Response("upstream returned unparseable JSON", { status: 502 }),
      };
    }
    accumulate(usage, upstreamBody.usage);
    lastUpstreamBody = upstreamBody;

    const decoded = strategy.decode(upstreamBody, body);
    if (decoded.ok) {
      return {
        body: {
          id: upstreamBody.id ?? `chatcmpl-fox-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: upstreamBody.created ?? Math.floor(Date.now() / 1000),
          model: upstreamBody.model ?? route.model,
          choices: [
            { index: 0, message: decoded.message, finish_reason: decoded.finishReason },
          ],
          usage,
        },
        repairs: attempt,
      };
    }
    lastError = decoded.error;
    if (attempt < maxAttempts) {
      // Repair turns are internal: they go back to the SAME upstream that just
      // produced this output (no new exposure), and the agent-facing result is
      // scanned by the response-phase detectors in Pipeline OUT either way.
      messages = [...messages, ...strategy.repairTurn(upstreamBody, decoded.repairHint)];
    }
  }

  // final failure (§6.4): standard completion shape, finish_reason "error"
  return {
    body: {
      id: lastUpstreamBody?.id ?? `chatcmpl-fox-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: lastUpstreamBody?.created ?? Math.floor(Date.now() / 1000),
      model: lastUpstreamBody?.model ?? route.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: "error",
        },
      ],
      usage,
      foxfence: { parse_error: lastError },
    },
    repairs: maxAttempts,
    parseError: lastError,
  };
}
