import type { ModelRoute, Upstream } from "../config/schema.ts";

/** Response headers worth relaying to the agent. Everything else (upstream
 * auth echoes, hop-by-hop headers, server identification) is dropped. */
const RELAYED_RESPONSE_HEADERS = ["content-type", "cache-control", "x-request-id"];

export class UpstreamError extends Error {
  constructor(
    public readonly upstreamName: string,
    public readonly detail: string,
  ) {
    super(`failed to reach upstream "${upstreamName}": ${detail}`);
  }
}

/**
 * Calls the upstream's /chat/completions and returns the raw fetch Response.
 *
 * - the request body is forwarded as received, except `model`, rewritten
 *   from the exposed name to the upstream's real model id;
 * - the agent's Authorization header is never forwarded; the upstream gets
 *   its own configured key or no auth at all.
 *
 * Egress allowlist (§5.1): this is the only place foxfence opens a network
 * connection, and `upstream` can only come from the validated config.
 */
export async function callUpstream(
  body: Record<string, unknown>,
  route: ModelRoute,
  upstream: Upstream,
): Promise<Response> {
  const url = `${upstream.base_url.replace(/\/+$/, "")}/chat/completions`;

  const headers = new Headers({ "content-type": "application/json" });
  if (upstream.api_key) headers.set("authorization", `Bearer ${upstream.api_key}`);
  const streaming = body.stream === true;
  if (streaming) headers.set("accept", "text/event-stream");

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, model: route.model }),
  };
  // Bound non-streaming calls so a hung model fails fast (§ upstream timeout).
  // Streaming is left unbounded — aborting would kill a legitimately long
  // stream; only the initial connect is implicitly covered by fetch itself.
  if (!streaming && typeof upstream.timeout_ms === "number") {
    init.signal = AbortSignal.timeout(upstream.timeout_ms);
  }

  try {
    return await fetch(url, init);
  } catch (e) {
    const detail =
      e instanceof Error && e.name === "TimeoutError"
        ? `timed out after ${upstream.timeout_ms}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    throw new UpstreamError(upstream.name, detail);
  }
}

/** Builds the agent-facing headers for a relayed upstream response. */
export function relayHeaders(upstreamResponse: Response): Headers {
  const headers = new Headers();
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** Relays an upstream response body byte-for-byte (streaming included). */
export function relayResponse(upstreamResponse: Response): Response {
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: relayHeaders(upstreamResponse),
  });
}
