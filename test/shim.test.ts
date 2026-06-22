/** Tool-calling shim tests (§6): probe + auto strategy selection, the
 * json-prompted encode/decode, argument validation, the bounded repair loop,
 * runtime downgrade, and buffered SSE replay for shimmed streams. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { extractJsonObject, transformHistory, buildToolSystemBlock } from "../src/shim/json-prompted.ts";
import { validateAgainstSchema } from "../src/shim/args-validate.ts";
import { startFakeUpstream, toolCallCompletion, type FakeUpstream } from "./helpers/fake-upstream.ts";

const WEATHER_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

/** Narrows the SDK's tool-call union to the function variant. */
function fnCall(res: OpenAI.ChatCompletion): { name: string; arguments: string } | undefined {
  const call = res.choices[0]?.message.tool_calls?.[0];
  return call && "function" in call ? call.function : undefined;
}

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
});

function makeServer(modelOverrides: Record<string, unknown> = {}) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
    models: [{ expose: "shimmed", upstream: "fake", model: "real-model", ...modelOverrides }],
  });
  const server = createServer(config);
  const client = new OpenAI({
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "unused",
  });
  return { server, client };
}

/** A model with real native tool support: answers any tools request with a
 * well-formed call of the first declared tool. */
function nativeModelHandler(body: Record<string, unknown>): string | Record<string, unknown> {
  const tools = body.tools as Array<{ function: { name: string } }> | undefined;
  if (tools && tools.length > 0) {
    const name = tools[0]!.function.name;
    const args = name === "fox_ping" ? { value: "pong" } : { city: "Paris" };
    return toolCallCompletion(body.model as string, name, args);
  }
  return "plain answer";
}

/** A model with no tool support: ignores `tools`, but speaks the shim's JSON
 * protocol when the injected system block is present. */
function shimSpeakingHandler(reply: string) {
  return (body: Record<string, unknown>): string => {
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return "I am a simple model and cannot use tools.";
    }
    return reply;
  };
}

describe("unit: tolerant JSON extraction", () => {
  test("strict, fenced, and prose-embedded objects all parse", () => {
    const obj = { tool_call: { name: "x", arguments: { a: 1 } } };
    const json = JSON.stringify(obj);
    expect(extractJsonObject(json)).toEqual(obj);
    expect(extractJsonObject("```json\n" + json + "\n```")).toEqual(obj);
    expect(extractJsonObject("Sure! Here you go:\n" + json + "\nLet me know!")).toEqual(obj);
  });

  test("strings with braces inside JSON don't break the scan", () => {
    const obj = { final: 'use {curly} braces and "quotes" wisely' };
    expect(extractJsonObject("answer: " + JSON.stringify(obj))).toEqual(obj);
  });

  test("no JSON yields null", () => {
    expect(extractJsonObject("there is no JSON here at all")).toBeNull();
  });
});

describe("unit: history transform for non-native models", () => {
  test("assistant tool_calls and tool results become plain turns", () => {
    const out = transformHistory([
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temp": 21}' },
    ]);
    expect(out.every((m) => m.role !== "tool")).toBe(true);
    expect(out[1]?.content).toContain('"tool_call"');
    expect(out[2]?.role).toBe("user");
    expect(out[2]?.content).toContain('Tool result for "get_weather"');
  });
});

describe("unit: argument schema validation", () => {
  const schema = WEATHER_TOOL.function.parameters as Record<string, unknown>;
  test("valid, missing-required, wrong-type, extra-property", () => {
    expect(validateAgainstSchema({ city: "Paris" }, schema)).toEqual([]);
    expect(validateAgainstSchema({}, schema)[0]).toContain('missing required property "city"');
    expect(validateAgainstSchema({ city: 42 }, schema)[0]).toContain("expected type string");
    expect(validateAgainstSchema({ city: "Paris", lang: "fr" }, schema)[0]).toContain(
      'unexpected property "lang"',
    );
  });
});

describe("unit: tool system block", () => {
  test("describes tools and pins forced tool_choice", () => {
    const block = buildToolSystemBlock({
      tools: [WEATHER_TOOL],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
    expect(block).toContain("get_weather");
    expect(block).toContain("parameters schema");
    expect(block).toContain('MUST call the tool "get_weather"');
  });
});

describe("auto mode with a native-capable model", () => {
  test("probes once, then passes tool calls through validated", async () => {
    upstream.handler = nativeModelHandler;
    const { server, client } = makeServer();
    try {
      const create = () =>
        client.chat.completions.create({
          model: "shimmed",
          messages: [{ role: "user", content: "weather in Paris?" }],
          tools: [WEATHER_TOOL],
        });
      const res1 = await create();
      await create();

      expect(fnCall(res1)?.name).toBe("get_weather");
      expect(res1.choices[0]?.finish_reason).toBe("tool_calls");

      // exactly one probe (fox_ping) across both requests
      const probes = upstream.requests.filter((r) =>
        JSON.stringify(r.body.tools ?? "").includes("fox_ping"),
      );
      expect(probes.length).toBe(1);
      // real requests kept their native tools field
      const real = upstream.requests.filter((r) =>
        JSON.stringify(r.body.tools ?? "").includes("get_weather"),
      );
      expect(real.length).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});

describe("auto mode with a tool-incapable model", () => {
  test("falls back to json-prompted and emits clean OpenAI tool calls", async () => {
    upstream.handler = shimSpeakingHandler(
      '{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}',
    );
    const { server, client } = makeServer();
    try {
      const res = await client.chat.completions.create({
        model: "shimmed",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
      });
      const call = fnCall(res);
      expect(call?.name).toBe("get_weather");
      expect(JSON.parse(call!.arguments)).toEqual({ city: "Paris" });
      expect(res.choices[0]?.finish_reason).toBe("tool_calls");

      // the shimmed upstream request has no tools field and carries the
      // injected system block instead
      const last = upstream.requests.at(-1)!.body;
      expect(last.tools).toBeUndefined();
      const messages = last.messages as Array<{ role: string; content: string }>;
      expect(messages[0]!.role).toBe("system");
      expect(messages[0]!.content).toContain("Available tools");

      const meta = (res as Record<string, any>).foxfence;
      expect(meta.shim.strategy).toBe("json-prompted");
    } finally {
      server.stop(true);
    }
  });

  test("a {final} reply becomes plain content with finish_reason stop", async () => {
    upstream.handler = shimSpeakingHandler('{"final": "It is sunny in Paris."}');
    const { server, client } = makeServer();
    try {
      const res = await client.chat.completions.create({
        model: "shimmed",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
      });
      expect(res.choices[0]?.message.content).toBe("It is sunny in Paris.");
      expect(res.choices[0]?.finish_reason).toBe("stop");
      expect(res.choices[0]?.message.tool_calls).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

describe("repair loop (§6.4)", () => {
  test("an invalid reply is repaired; repairs are visible and bounded", async () => {
    let shimCalls = 0;
    upstream.handler = (body) => {
      if (Array.isArray(body.tools) && body.tools.length > 0) return "no tools for me";
      shimCalls++;
      return shimCalls === 1
        ? 'here: {"tool_call": {"name": "get_weather", "arguments": {'
        : '{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}';
    };
    const { server } = makeServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "shimmed",
          messages: [{ role: "user", content: "weather in Paris?" }],
          tools: [WEATHER_TOOL],
        }),
      });
      expect(res.headers.get("x-foxfence-repairs")).toBe("1");
      const body = (await res.json()) as Record<string, any>;
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
      expect(body.foxfence.shim.repairs).toBe(1);

      // the repair turn carried the error back to the model
      const repairRequest = upstream.requests.at(-1)!.body;
      const messages = repairRequest.messages as Array<{ role: string; content: string }>;
      expect(messages.at(-1)!.content).toContain("invalid");
    } finally {
      server.stop(true);
    }
  });

  test("invalid arguments trigger repair with a precise schema hint", async () => {
    let shimCalls = 0;
    upstream.handler = (body) => {
      if (Array.isArray(body.tools) && body.tools.length > 0) return "no tools";
      shimCalls++;
      return shimCalls === 1
        ? '{"tool_call": {"name": "get_weather", "arguments": {"town": "Paris"}}}'
        : '{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}';
    };
    const { server } = makeServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "shimmed",
          messages: [{ role: "user", content: "weather?" }],
          tools: [WEATHER_TOOL],
        }),
      });
      const body = (await res.json()) as Record<string, any>;
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
      const messages = upstream.requests.at(-1)!.body.messages as Array<{ content: string }>;
      expect(messages.at(-1)!.content).toContain('missing required property "city"');
    } finally {
      server.stop(true);
    }
  });

  test("exhausted repairs return finish_reason error with foxfence.parse_error", async () => {
    upstream.handler = shimSpeakingHandler("{ this is never valid json }");
    const { server } = makeServer({ repair: { max_attempts: 1 } });
    try {
      const before = upstream.requests.length;
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "shimmed",
          messages: [{ role: "user", content: "weather?" }],
          tools: [WEATHER_TOOL],
          tool_choice: "required",
        }),
      });
      const body = (await res.json()) as Record<string, any>;
      expect(body.choices[0].finish_reason).toBe("error");
      expect(body.foxfence.parse_error).toBeString();
      // 1 probe + 1 attempt + 1 repair
      expect(upstream.requests.length - before).toBe(3);
    } finally {
      server.stop(true);
    }
  });
});

describe("pinning and probe modes", () => {
  test("shim: json-prompted skips the probe entirely", async () => {
    upstream.handler = shimSpeakingHandler('{"final": "ok"}');
    const { server, client } = makeServer({ shim: "json-prompted" });
    try {
      const before = upstream.requests.length;
      await client.chat.completions.create({
        model: "shimmed",
        messages: [{ role: "user", content: "hi" }],
        tools: [WEATHER_TOOL],
      });
      const seen = upstream.requests.slice(before);
      expect(seen.length).toBe(1); // no probe call
      expect(JSON.stringify(seen[0]!.body)).not.toContain("fox_ping");
    } finally {
      server.stop(true);
    }
  });

  test("probe: off with auto assumes native passthrough", async () => {
    upstream.handler = nativeModelHandler;
    const { server, client } = makeServer({ probe: "off" });
    try {
      const before = upstream.requests.length;
      const res = await client.chat.completions.create({
        model: "shimmed",
        messages: [{ role: "user", content: "weather?" }],
        tools: [WEATHER_TOOL],
      });
      expect(fnCall(res)?.name).toBe("get_weather");
      expect(upstream.requests.length - before).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("runtime downgrade (§6.1)", () => {
  test("repeated native parse failures switch the model to json-prompted", async () => {
    // phase 1 of the scenario: the model probes native
    let act: "native" | "broken" | "shim-only" = "native";
    upstream.handler = (body) => {
      if (act === "native") return nativeModelHandler(body);
      if (act === "broken") {
        // native-looking model that now answers text despite demanded tools
        return "I refuse to call tools today.";
      }
      // after downgrade the shim strips tools; speak the JSON protocol
      return shimSpeakingHandler(
        '{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}',
      )(body);
    };
    const { server } = makeServer({ repair: { max_attempts: 0 } });
    const post = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "shimmed",
          messages: [{ role: "user", content: "weather?" }],
          tools: [WEATHER_TOOL],
          tool_choice: "required",
        }),
      });
    try {
      await post(); // probe (native) + clean native call
      act = "broken";
      const fail1 = (await (await post()).json()) as Record<string, any>;
      const fail2 = (await (await post()).json()) as Record<string, any>;
      expect(fail1.choices[0].finish_reason).toBe("error");
      expect(fail2.choices[0].finish_reason).toBe("error");

      act = "shim-only";
      const recovered = (await (await post()).json()) as Record<string, any>;
      expect(recovered.foxfence.shim.strategy).toBe("json-prompted");
      expect(recovered.foxfence.shim.source).toBe("runtime-downgrade");
      expect(recovered.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    } finally {
      server.stop(true);
    }
  });
});

describe("shimmed streaming (buffered replay)", () => {
  test("stream:true with a shimmed model yields conformant tool_call chunks", async () => {
    upstream.handler = shimSpeakingHandler(
      '{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}',
    );
    const { server, client } = makeServer();
    try {
      const stream = await client.chat.completions.create({
        model: "shimmed",
        messages: [{ role: "user", content: "weather?" }],
        tools: [WEATHER_TOOL],
        stream: true,
      });
      let toolName = "";
      let args = "";
      let finish: string | null = null;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        const call = delta?.tool_calls?.[0];
        if (call?.function?.name) toolName = call.function.name;
        if (call?.function?.arguments) args += call.function.arguments;
        if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      }
      expect(toolName).toBe("get_weather");
      expect(JSON.parse(args)).toEqual({ city: "Paris" });
      expect(finish).toBe("tool_calls");
    } finally {
      server.stop(true);
    }
  });
});

describe("interplay with the safety pipeline", () => {
  test("placeholders echoed into tool arguments are restored", async () => {
    const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
    upstream.handler = (body) => {
      if (Array.isArray(body.tools) && body.tools.length > 0) return "no tools";
      // echo the masked user content into the tool arguments
      const messages = body.messages as Array<{ content?: unknown }>;
      const user = String(messages.at(-1)?.content ?? "");
      const placeholder = user.match(/__fox_secret_\d+__/)?.[0] ?? "none";
      return JSON.stringify({
        tool_call: { name: "get_weather", arguments: { city: placeholder } },
      });
    };
    const { server, client } = makeServer();
    try {
      const res = await client.chat.completions.create({
        model: "shimmed",
        messages: [{ role: "user", content: `check ${AWS_KEY} for me` }],
        tools: [WEATHER_TOOL],
      });
      expect(fnCall(res)?.arguments).toContain(AWS_KEY);
    } finally {
      server.stop(true);
    }
  });

  test("tool_choice none bypasses the shim entirely", async () => {
    upstream.mode = "fixed";
    upstream.reply = "no tool needed";
    const { server, client } = makeServer();
    try {
      const before = upstream.requests.length;
      const res = await client.chat.completions.create({
        model: "shimmed",
        messages: [{ role: "user", content: "hi" }],
        tools: [WEATHER_TOOL],
        tool_choice: "none",
      });
      expect(res.choices[0]?.message.content).toBe("no tool needed");
      expect(upstream.requests.length - before).toBe(1); // no probe
    } finally {
      server.stop(true);
    }
  });
});
