/** Upstream request-timeout tests: a non-streaming call to a stalled upstream
 * fails fast as a clean 502 instead of hanging; a call that finishes within the
 * budget passes through normally; streaming is left unbounded. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";

/** An upstream that waits `delayMs` before answering /chat/completions. */
function startSlowUpstream(delayMs: number) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      await Bun.sleep(delayMs);
      return Response.json({
        id: "x",
        object: "chat.completion",
        created: 1700000000,
        model: "real",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

let slow: ReturnType<typeof startSlowUpstream>;
beforeAll(() => {
  slow = startSlowUpstream(300);
});
afterAll(() => {
  slow.stop();
});

function makeServer(timeout_ms?: number) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "slow", base_url: slow.baseUrl, ...(timeout_ms ? { timeout_ms } : {}) }],
    // No tools in the requests below → no probe, plain non-streaming path.
    models: [{ expose: "m", upstream: "slow", model: "real" }],
  });
  return createServer(config);
}

async function post(server: ReturnType<typeof createServer>, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("upstream timeout_ms", () => {
  test("a stalled non-streaming call fails fast as a 502", async () => {
    const server = makeServer(50); // upstream takes 300ms; bound at 50ms
    try {
      const res = await post(server, { model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(502);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("upstream_unreachable");
      expect(body.error.message).toContain("timed out after 50ms");
    } finally {
      server.stop(true);
    }
  });

  test("a call within the budget passes through", async () => {
    const server = makeServer(5000); // generous; the 300ms upstream finishes
    try {
      const res = await post(server, { model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.choices[0].message.content).toBe("ok");
    } finally {
      server.stop(true);
    }
  });

  test("no timeout configured → no bound (slow call still succeeds)", async () => {
    const server = makeServer(); // omitted
    try {
      const res = await post(server, { model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});
