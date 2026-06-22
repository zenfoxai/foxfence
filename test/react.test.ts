/** ReAct strategy tests (§6.2 #4): Thought/Action/Action Input parsing, the
 * bare-value fallback for one-arg tools, repair paths, and end-to-end through
 * a pinned `shim: react` against a simulated tiny model. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import {
  parseReactOutput,
  buildReactSystemBlock,
  transformReactHistory,
} from "../src/shim/react.ts";
import type { ToolDef } from "../src/shim/strategy.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

const WEATHER: ToolDef = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" }, days: { type: "integer" } },
      required: ["city"],
    },
  },
};
const SEARCH: ToolDef = {
  type: "function",
  function: {
    name: "search",
    description: "Search the web",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

function fnCall(res: OpenAI.ChatCompletion) {
  const call = res.choices[0]?.message.tool_calls?.[0];
  return call && "function" in call ? call.function : undefined;
}

describe("parseReactOutput", () => {
  test("Action + JSON Action Input → a clean tool call", () => {
    const r = parseReactOutput(
      'Thought: I should check the weather.\nAction: get_weather\nAction Input: {"city": "Paris"}',
      [WEATHER],
      false,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.finishReason).toBe("tool_calls");
    expect((r.message.tool_calls as any)[0].function.name).toBe("get_weather");
    expect(JSON.parse((r.message.tool_calls as any)[0].function.arguments)).toEqual({ city: "Paris" });
  });

  test("bare Action Input maps onto a one-argument tool", () => {
    const r = parseReactOutput("Action: search\nAction Input: best espresso machines", [SEARCH], false);
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse((r.message.tool_calls as any)[0].function.arguments)).toEqual({
      query: "best espresso machines",
    });
  });

  test("scalar coercion for a numeric single arg", () => {
    const counter: ToolDef = {
      type: "function",
      function: {
        name: "set_count",
        description: "set",
        parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      },
    };
    const r = parseReactOutput("Action: set_count\nAction Input: 5", [counter], false);
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse((r.message.tool_calls as any)[0].function.arguments)).toEqual({ n: 5 });
  });

  test("Final Answer → plain content", () => {
    const r = parseReactOutput("Thought: easy.\nFinal Answer: It is sunny.", [WEATHER], false);
    if (!r.ok) throw new Error(r.error);
    expect(r.finishReason).toBe("stop");
    expect(r.message.content).toBe("It is sunny.");
  });

  test("plain text with no markers becomes the answer (Thought label stripped)", () => {
    const r = parseReactOutput("Thought: The capital of France is Paris.", [WEATHER], false);
    if (!r.ok) throw new Error(r.error);
    expect(r.message.content).toBe("The capital of France is Paris.");
  });

  test("a Final Answer when a tool was required triggers repair", () => {
    const r = parseReactOutput("Final Answer: nope", [WEATHER], true);
    expect(r.ok).toBe(false);
  });

  test("invalid arguments (missing required) trigger repair", () => {
    const r = parseReactOutput('Action: get_weather\nAction Input: {"days": 3}', [WEATHER], false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("city");
  });

  test("an unknown tool name triggers repair", () => {
    const r = parseReactOutput("Action: teleport\nAction Input: {}", [WEATHER], false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown tool");
  });

  test("Observation after Action Input does not bleed into the arguments", () => {
    const r = parseReactOutput(
      'Action: get_weather\nAction Input: {"city": "Rome"}\nObservation: 24C',
      [WEATHER],
      false,
    );
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse((r.message.tool_calls as any)[0].function.arguments)).toEqual({ city: "Rome" });
  });
});

describe("buildReactSystemBlock / transformReactHistory", () => {
  test("system block lists tools and the format, and pins a forced tool", () => {
    const block = buildReactSystemBlock({
      tools: [WEATHER],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
    expect(block).toContain("Action Input:");
    expect(block).toContain("get_weather");
    expect(block).toContain('MUST call the tool "get_weather"');
  });

  test("history renders tool calls as Action and results as Observation", () => {
    const out = transformReactHistory([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ]);
    expect(out[1]!.content).toContain("Action: get_weather");
    expect(out[2]!.role).toBe("user");
    expect(out[2]!.content).toContain("Observation: sunny");
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

function makeServer(shim = "react", profile?: unknown) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "u", base_url: upstream.baseUrl }],
    models: [{ expose: "tiny", upstream: "u", model: "real", shim, ...(profile ? { profile } : {}) }],
  });
  const server = createServer(config);
  const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "x" });
  return { server, client };
}

describe("end-to-end shim: react", () => {
  test("a tiny model emitting ReAct text yields a clean OpenAI tool call", async () => {
    upstream.handler = () => "Thought: I'll look it up.\nAction: get_weather\nAction Input: {\"city\": \"Paris\"}";
    const { server, client } = makeServer();
    try {
      const before = upstream.requests.length;
      const res = await client.chat.completions.create({
        model: "tiny",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER],
      });
      expect(fnCall(res)?.name).toBe("get_weather");
      expect((res as any).foxfence.shim.strategy).toBe("react");
      // pinned → no probe, and the upstream got a ReAct system block, no tools
      expect(upstream.requests.length - before).toBe(1);
      const sent = upstream.requests.at(-1)!.body;
      expect(sent.tools).toBeUndefined();
      const msgs = sent.messages as Array<{ role: string; content: string }>;
      expect(msgs[0]!.content).toContain("Action Input:");
    } finally {
      server.stop(true);
    }
  });

  test("malformed ReAct is repaired", async () => {
    let n = 0;
    upstream.handler = () => {
      n++;
      return n === 1
        ? "Action: get_weather\nAction Input: city is Paris and also lots of prose" // not JSON, two-ish args
        : 'Action: get_weather\nAction Input: {"city": "Paris"}';
    };
    const { server } = makeServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "tiny",
          messages: [{ role: "user", content: "weather?" }],
          tools: [WEATHER],
          tool_choice: "required",
        }),
      });
      expect(res.headers.get("x-foxfence-repairs")).toBe("1");
      const body = (await res.json()) as Record<string, any>;
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    } finally {
      server.stop(true);
    }
  });
});

describe("config", () => {
  test("shim: react is now accepted (no longer a roadmap error)", () => {
    expect(() =>
      ConfigSchema.parse({
        listen: "127.0.0.1:0",
        upstreams: [{ name: "u", base_url: "http://x.test/v1" }],
        models: [{ expose: "m", upstream: "u", model: "real", shim: "react" }],
      }),
    ).not.toThrow();
  });

  test("a profile can pin react", async () => {
    upstream.handler = () => "Thought: ok\nFinal Answer: hello";
    const { server, client } = makeServer("auto", { pinStrategy: "react" });
    try {
      const res = await client.chat.completions.create({
        model: "tiny",
        messages: [{ role: "user", content: "hi" }],
        tools: [WEATHER],
      });
      expect((res as any).foxfence.shim.strategy).toBe("react");
      expect((res as any).foxfence.shim.source).toBe("profile");
    } finally {
      server.stop(true);
    }
  });
});
