/** Incremental streaming (§6.5): content streams token-by-token through the
 * sanitizer; native tool calls stream over SSE and are validated + policy-
 * checked; secrets split across chunks are redacted, never leaked. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

const GH = "ghp_abcDEF123456789012345678901234567890";
const WEATHER_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

let upstream: FakeUpstream;
beforeAll(() => {
  upstream = startFakeUpstream();
});
afterAll(() => upstream.stop());
afterEach(() => {
  upstream.handler = null;
  upstream.mode = "fixed";
  upstream.sseToolCall = null;
  upstream.reply = "Hello from the fake model.";
});

function makeServer(opts: { security?: Record<string, unknown>; shim?: string } = {}) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "u", base_url: upstream.baseUrl }],
    models: [{ expose: "m", upstream: "u", model: "real", ...(opts.shim ? { shim: opts.shim } : {}) }],
    ...(opts.security ? { security: opts.security } : {}),
  });
  const server = createServer(config);
  const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "x" });
  return { server, client };
}

async function collect(stream: AsyncIterable<any>) {
  let content = "";
  let contentDeltas = 0;
  let toolName = "";
  let toolArgs = "";
  let finish: string | null = null;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      content += delta.content;
      contentDeltas++;
    }
    const call = delta?.tool_calls?.[0];
    if (call?.function?.name) toolName = call.function.name;
    if (call?.function?.arguments) toolArgs += call.function.arguments;
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
  }
  return { content, contentDeltas, toolName, toolArgs, finish };
}

describe("incremental text streaming", () => {
  test("a tool-free stream is delivered in multiple content deltas", async () => {
    upstream.reply = "The quick brown fox jumps over the lazy dog repeatedly.";
    const { server, client } = makeServer(); // no security → pure passthrough
    try {
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      const out = await collect(stream);
      expect(out.content).toBe(upstream.reply);
      expect(out.contentDeltas).toBeGreaterThan(1); // genuinely incremental
      expect(out.finish).toBe("stop");
    } finally {
      server.stop(true);
    }
  });
});

describe("upstream that ends early", () => {
  test("a stream that closes without a finish_reason is still terminated cleanly", async () => {
    // exercises the finalization/lifecycle path: deliver partial content, then
    // the upstream just closes — foxfence must still flush, finish, and [DONE].
    upstream.handler = () =>
      new Response(
        new ReadableStream({
          start(c) {
            const ev = (delta: unknown) =>
              `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
            c.enqueue(new TextEncoder().encode(ev({ role: "assistant" }) + ev({ content: "partial answer" })));
            c.close(); // ends without ever sending a finish_reason
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const { server, client } = makeServer();
    try {
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      let content = "";
      let finish: string | null = null;
      for await (const chunk of stream) {
        content += chunk.choices[0]?.delta?.content ?? "";
        if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      }
      expect(content).toContain("partial answer");
      expect(finish).toBe("stop"); // foxfence supplies a terminal finish_reason
    } finally {
      server.stop(true);
    }
  });
});

describe("secret redaction across chunk boundaries", () => {
  test("a github token split across SSE chunks is redacted, never leaked", async () => {
    upstream.reply = `your token is ${GH} keep it secret`;
    const { server, client } = makeServer({ security: { detectors: { secrets: { action: "mask" } } } });
    try {
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "give me a token" }],
        stream: true,
      });
      const out = await collect(stream);
      expect(out.content).toContain("[REDACTED:github-token]");
      expect(out.content).not.toContain(GH);
    } finally {
      server.stop(true);
    }
  });
});

describe("native tool calls over SSE", () => {
  test("a streamed tool call is assembled, validated, and emitted", async () => {
    upstream.sseToolCall = { name: "get_weather", args: { city: "Paris" } };
    const { server, client } = makeServer({ shim: "native" }); // pin native → no probe
    try {
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
        stream: true,
      });
      const out = await collect(stream);
      expect(out.toolName).toBe("get_weather");
      expect(JSON.parse(out.toolArgs)).toEqual({ city: "Paris" });
      expect(out.finish).toBe("tool_calls");
    } finally {
      server.stop(true);
    }
  });

  test("tool-policy blocks a streamed call: no tool_calls, refusal content", async () => {
    upstream.sseToolCall = { name: "get_weather", args: { city: "Paris" } };
    const { server, client } = makeServer({
      shim: "native",
      security: { tool_policy: { default: "allow", rules: [{ tool: "get_weather", action: "block", message: "Weather is off." }] } },
    });
    try {
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather?" }],
        tools: [WEATHER_TOOL],
        stream: true,
      });
      const out = await collect(stream);
      expect(out.toolName).toBe(""); // the call never reached the client
      expect(out.content).toContain("Weather is off.");
      expect(out.finish).toBe("stop");
    } finally {
      server.stop(true);
    }
  });

  test("two streamed tool calls without index fields are not merged", async () => {
    // a non-compliant upstream omits `index`; the assembler must keep them
    // separate via the new-call markers (id/name), not collapse to index 0.
    upstream.handler = () => {
      const ev = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const body =
        ev({ role: "assistant" }) +
        ev({ tool_calls: [{ id: "a", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }) +
        ev({ tool_calls: [{ id: "b", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }] }) +
        ev({}, "tool_calls") +
        "data: [DONE]\n\n";
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ) as any;
    };
    const { server, client } = makeServer({ shim: "native" });
    try {
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather in two cities" }],
        tools: [WEATHER_TOOL],
        stream: true,
      });
      const calls: any[] = [];
      for await (const chunk of stream) {
        for (const c of chunk.choices[0]?.delta?.tool_calls ?? []) {
          calls[c.index] = (calls[c.index] ?? "") + (c.function?.arguments ?? "");
        }
      }
      expect(calls.filter(Boolean)).toHaveLength(2); // two distinct calls, not merged
    } finally {
      server.stop(true);
    }
  });

  test("a placeholder echoed into streamed tool arguments is restored", async () => {
    const AWS = "AKIAIOSFODNN7EXAMPLE";
    // model streams a tool call whose argument is the masked placeholder
    upstream.handler = null;
    const { server, client } = makeServer({ shim: "native", security: { detectors: { secrets: { action: "mask" } } } });
    try {
      // first, find the placeholder the request masking will produce
      upstream.sseToolCall = { name: "get_weather", args: { city: "__fox_secret_1__" } };
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: `lookup ${AWS} now` }],
        tools: [WEATHER_TOOL],
        stream: true,
      });
      const out = await collect(stream);
      expect(out.toolArgs).toContain(AWS); // restored in the streamed args
    } finally {
      server.stop(true);
    }
  });
});
