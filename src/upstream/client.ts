import type { ModelRoute, Upstream } from "../config/schema.ts";
import { errors } from "../pivot/errors.ts";

/** Response headers worth relaying to the agent. Everything else (upstream
 * auth echoes, hop-by-hop headers, server identification) is dropped. */
const RELAYED_RESPONSE_HEADERS = ["content-type", "cache-control", "x-request-id"];

/**
 * Forwards a chat completion to the upstream and relays the response.
 *
 * Phase 1 passthrough contract (design principle #4):
 * - the request body is forwarded as received, except `model`, rewritten
 *   from the exposed name to the upstream's real model id;
 * - the response body (JSON or SSE stream) is relayed byte-for-byte. The
 *   `model` field in responses therefore shows the upstream's real id;
 *   normalization to the exposed name lands with Pipeline OUT (phase 2).
 * - the agent's Authorization header is never forwarded; the upstream gets
 *   its own configured key or no auth at all.
 *
 * Egress allowlist (§5.1): this is the only place foxfence opens a network
 * connection, and `upstream` can only come from the validated config.
 */
export async function forwardChatCompletion(
  body: Record<string, unknown>,
  route: ModelRoute,
  upstream: Upstream,
): Promise<Response> {
  const url = `${upstream.base_url.replace(/\/+$/, "")}/chat/completions`;

  const headers = new Headers({ "content-type": "application/json" });
  if (upstream.api_key) headers.set("authorization", `Bearer ${upstream.api_key}`);
  if (body.stream === true) headers.set("accept", "text/event-stream");

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: route.model }),
    });
  } catch (e) {
    return errors.upstreamUnreachable(upstream.name, e instanceof Error ? e.message : String(e));
  }

  const responseHeaders = new Headers();
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
