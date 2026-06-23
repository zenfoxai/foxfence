/** Loop-breaker tests (failure mode: infinite retry loops). Unit tests for the
 * stateless detector, plus integration tests that drive the live server and
 * verify the nudge is injected into the outbound request and that "break"
 * short-circuits without an upstream call. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import {
  detectToolCallLoop,
  loopBreakResponse,
  loopBreakerNudge,
} from "../src/loop.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

/** Builds a history of `n` identical assistant tool calls, each followed by a
 * `tool` error result — the canonical stuck-loop shape. */
function loopHistory(
  n: number,
  name: string,
  args: Record<string, unknown>,
  error = "Error: service unavailable.",
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "do the thing" }];
  for (let i = 0; i < n; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: error });
  }
  return messages;
}

describe("detectToolCallLoop", () => {
  test("fires at the threshold of identical calls", () => {
    const d = detectToolCallLoop(loopHistory(3, "get_weather", { city: "Paris" }), 3);
    expect(d).not.toBeNull();
    expect(d!.tool).toBe("get_weather");
    expect(d!.count).toBe(3);
    expect(JSON.parse(d!.arguments)).toEqual({ city: "Paris" });
  });

  test("does not fire below the threshold", () => {
    expect(detectToolCallLoop(loopHistory(2, "get_weather", { city: "Paris" }), 3)).toBeNull();
  });

  test("canonicalizes argument key order (reordered keys are the same call)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: '{"a":1,"b":2}' } }] },
      { role: "tool", tool_call_id: "a", content: "err" },
      { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "f", arguments: '{"b":2,"a":1}' } }] },
      { role: "tool", tool_call_id: "b", content: "err" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: '{"a":1,  "b":2}' } }] },
    ];
    expect(detectToolCallLoop(messages, 3)).not.toBeNull();
  });

  test("a different call before the tail ends the run", () => {
    const messages = [
      ...[
        { role: "assistant", content: null, tool_calls: [{ id: "z", type: "function", function: { name: "f", arguments: '{"x":9}' } }] },
        { role: "tool", tool_call_id: "z", content: "err" },
      ],
      ...loopHistory(2, "f", { x: 1 }),
    ];
    // Only 2 identical at the tail → below threshold.
    expect(detectToolCallLoop(messages, 3)).toBeNull();
  });

  test("ignores non-array / short input and bad thresholds", () => {
    expect(detectToolCallLoop(null, 3)).toBeNull();
    expect(detectToolCallLoop(loopHistory(5, "f", { x: 1 }), 1)).toBeNull();
  });

  test("nudge and break payloads name the offending tool", () => {
    const d = detectToolCallLoop(loopHistory(3, "search", { q: "x" }), 3)!;
    expect((loopBreakerNudge(d).content as string)).toContain("search");
    const broken = loopBreakResponse("m", d);
    expect((broken.foxfence as any).loop.action).toBe("break");
    expect((broken.choices as any)[0].finish_reason).toBe("stop");
  });
});

let upstream: FakeUpstream;
beforeAll(() => {
  upstream = startFakeUpstream();
});
afterAll(() => {
  upstream.stop();
});
afterEach(() => {
  upstream.handler = null;
  upstream.mode = "fixed";
  upstream.requests.length = 0;
});

function makeServer(loopOverrides: Record<string, unknown> = {}) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
    models: [{ expose: "m", upstream: "fake", model: "real", loop_breaker: loopOverrides }],
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

describe("loop-breaker pipeline integration", () => {
  test("nudge: appends a corrective system message to the outbound request", async () => {
    const server = makeServer(); // defaults: enabled, threshold 3, nudge
    try {
      const res = await post(server, { model: "m", messages: loopHistory(3, "get_weather", { city: "Paris" }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-foxfence-loop")).toBe("nudge");
      const body = (await res.json()) as Record<string, unknown>;
      expect((body.foxfence as any).loop.tool).toBe("get_weather");

      // The upstream actually received the nudge.
      const sent = upstream.requests.at(-1)!.body.messages as Array<Record<string, unknown>>;
      const nudge = sent.find((m) => m.role === "system" && String(m.content).includes("already been called"));
      expect(nudge).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  test("break: short-circuits without calling the upstream", async () => {
    const server = makeServer({ action: "break" });
    try {
      const res = await post(server, { model: "m", messages: loopHistory(3, "search", { q: "x" }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-foxfence-loop")).toBe("break");
      expect(upstream.requests.length).toBe(0); // never reached the model
      const body = (await res.json()) as Record<string, unknown>;
      expect((body.foxfence as any).loop.action).toBe("break");
      expect(String((body.choices as any)[0].message.content)).toContain("broke the retry loop");
    } finally {
      server.stop(true);
    }
  });

  test("healthy traffic is untouched (no repeated calls → no nudge)", async () => {
    const server = makeServer();
    try {
      const res = await post(server, { model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-foxfence-loop")).toBeNull();
      const sent = upstream.requests.at(-1)!.body.messages as Array<Record<string, unknown>>;
      expect(sent.some((m) => m.role === "system")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("disabled: no detection even on a clear loop", async () => {
    const server = makeServer({ enabled: false });
    try {
      const res = await post(server, { model: "m", messages: loopHistory(4, "get_weather", { city: "Paris" }) });
      expect(res.headers.get("x-foxfence-loop")).toBeNull();
      const sent = upstream.requests.at(-1)!.body.messages as Array<Record<string, unknown>>;
      expect(sent.some((m) => m.role === "system")).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
