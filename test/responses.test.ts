/** /v1/responses (§3, §8): the translation to/from the chat pivot and the
 * end-to-end endpoint, including tool calls and the official SDK. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { toChatRequest, toResponsesObject, toChatMessages, toChatTools } from "../src/pivot/responses.ts";
import { startFakeUpstream, toolCallCompletion, type FakeUpstream } from "./helpers/fake-upstream.ts";

describe("toChatMessages", () => {
  test("string input + instructions → system + user", () => {
    expect(toChatMessages("hello", "be terse")).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ]);
  });

  test("message items with part arrays are flattened to text", () => {
    const msgs = toChatMessages(
      [{ role: "user", content: [{ type: "input_text", text: "weather in " }, { type: "input_text", text: "Paris?" }] }],
      undefined,
    );
    expect(msgs).toEqual([{ role: "user", content: "weather in Paris?" }]);
  });

  test("prior function_call and function_call_output become assistant tool_calls + tool result", () => {
    const msgs = toChatMessages(
      [
        { role: "user", content: "weather?" },
        { type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' },
        { type: "function_call_output", call_id: "c1", output: "sunny" },
      ],
      undefined,
    );
    expect(msgs[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", function: { name: "get_weather" } }] });
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "sunny" });
  });
});

describe("toChatTools", () => {
  test("flat Responses function tools become nested chat tools", () => {
    const tools = toChatTools([{ type: "function", name: "get_weather", description: "w", parameters: { type: "object" } }]);
    expect(tools).toEqual([{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } }]);
  });
});

describe("toResponsesObject", () => {
  test("assistant text → an output message with output_text", () => {
    const r = toResponsesObject(
      { choices: [{ message: { role: "assistant", content: "It is sunny." }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      "m",
    );
    expect(r.object).toBe("response");
    expect(r.output_text).toBe("It is sunny.");
    expect((r.output as any[])[0]).toMatchObject({ type: "message", role: "assistant" });
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 3, total_tokens: 8 });
  });

  test("tool calls → function_call output items", () => {
    const r = toResponsesObject(
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }, finish_reason: "tool_calls" }] },
      "m",
    );
    const fc = (r.output as any[]).find((o) => o.type === "function_call");
    expect(fc).toMatchObject({ call_id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' });
  });
});

// ── End-to-end ────────────────────────────────────────────────────
let upstream: FakeUpstream;
beforeAll(() => {
  upstream = startFakeUpstream();
});
afterAll(() => upstream.stop());
afterEach(() => {
  upstream.handler = null;
  upstream.mode = "fixed";
});

function makeServer() {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "u", base_url: upstream.baseUrl }],
    models: [{ expose: "m", upstream: "u", model: "real" }],
  });
  return createServer(config);
}

async function postResponses(server: ReturnType<typeof createServer>, body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, any> };
}

describe("the /v1/responses endpoint", () => {
  test("a simple request round-trips to a response object", async () => {
    upstream.reply = "Hello from the model.";
    const server = makeServer();
    try {
      const { res, body } = await postResponses(server, { model: "m", input: "hi" });
      expect(res.status).toBe(200);
      expect(body.object).toBe("response");
      expect(body.output_text).toBe("Hello from the model.");
    } finally {
      server.stop(true);
    }
  });

  test("a tool call surfaces as a function_call output item", async () => {
    upstream.handler = (b) =>
      toolCallCompletion(b.model as string, "get_weather", { city: "Paris" });
    const server = makeServer();
    try {
      const { body } = await postResponses(server, {
        model: "m",
        input: "weather in Paris?",
        tools: [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
      });
      const fc = body.output.find((o: any) => o.type === "function_call");
      expect(fc.name).toBe("get_weather");
      expect(JSON.parse(fc.arguments)).toEqual({ city: "Paris" });
    } finally {
      server.stop(true);
    }
  });

  test("streaming is rejected with a clear error", async () => {
    const server = makeServer();
    try {
      const { res, body } = await postResponses(server, { model: "m", input: "hi", stream: true });
      expect(res.status).toBe(400);
      expect(body.error.message).toContain("streaming is not yet supported");
    } finally {
      server.stop(true);
    }
  });

  test("the official SDK responses client works unmodified", async () => {
    upstream.reply = "SDK response.";
    const server = makeServer();
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "x" });
    try {
      const r = await client.responses.create({ model: "m", input: "hi" });
      expect(r.output_text).toBe("SDK response.");
    } finally {
      server.stop(true);
    }
  });
});
