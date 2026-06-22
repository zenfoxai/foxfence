/** Constrained strategy tests (§6.2 #2): the union schema, the encode for
 * both mechanisms, config wiring, and end-to-end selection/decoding against a
 * constraint-aware fake upstream. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { ConfigError } from "../src/config/load.ts";
import { buildUnionSchema, createConstrainedStrategy } from "../src/shim/constrained.ts";
import { chooseStrategy, CapabilityStore } from "../src/shim/probe.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

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
const SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "search",
    description: "Search",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
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
});

function fnCall(res: OpenAI.ChatCompletion) {
  const call = res.choices[0]?.message.tool_calls?.[0];
  return call && "function" in call ? call.function : undefined;
}

/** A constraint-aware fake: returns plain text for the probe (so it's
 * classified non-native), and a valid protocol object once it sees the
 * constraint field. */
function constrainedHandler(toolName: string, args: Record<string, unknown>) {
  return (body: Record<string, unknown>) => {
    if (Array.isArray(body.tools) && body.tools.some((t: any) => t.function?.name === "fox_ping")) {
      return "I cannot use tools natively."; // probe → classified "none"
    }
    if (body.response_format || body.guided_json) {
      return JSON.stringify({ tool_call: { name: toolName, arguments: args } });
    }
    return "no constraint was applied";
  };
}

describe("buildUnionSchema", () => {
  test("one branch per tool plus a final-answer branch", () => {
    const schema = buildUnionSchema({ tools: [WEATHER_TOOL, SEARCH_TOOL] }) as any;
    expect(schema.anyOf).toHaveLength(3);
    const names = schema.anyOf
      .map((b: any) => b.properties?.tool_call?.properties?.name?.const)
      .filter(Boolean);
    expect(names).toEqual(["get_weather", "search"]);
    expect(schema.anyOf.some((b: any) => b.properties?.final)).toBe(true);
  });

  test("a forced tool_choice collapses to that tool's single branch, no final", () => {
    const schema = buildUnionSchema({
      tools: [WEATHER_TOOL, SEARCH_TOOL],
      tool_choice: { type: "function", function: { name: "search" } },
    }) as any;
    expect(schema.anyOf).toBeUndefined(); // single branch, no wrapper
    expect(schema.properties.tool_call.properties.name.const).toBe("search");
  });

  test("tool_choice naming a non-existent tool stays permissive, not unsatisfiable", () => {
    // would otherwise be {anyOf: []} (matches nothing) → the server would error
    const schema = buildUnionSchema({
      tools: [WEATHER_TOOL],
      tool_choice: { type: "function", function: { name: "ghost" } },
    }) as any;
    expect(schema).toEqual({ type: "object" });
  });

  test("a tool with no parameters schema gets a permissive object branch", () => {
    const schema = buildUnionSchema({
      tools: [{ type: "function", function: { name: "ping", description: "p" } }],
      tool_choice: { type: "function", function: { name: "ping" } },
    }) as any;
    expect(schema.properties.tool_call.properties.arguments).toEqual({ type: "object" });
  });
});

describe("constrained pin degrades safely without a mechanism (defense-in-depth)", () => {
  test("chooseStrategy falls back to json-prompted instead of sending a bogus constraint", async () => {
    // config validation normally blocks this; if reached anyway, degrade.
    const route = { expose: "m", upstream: "u", model: "real", shim: "constrained" as const, probe: "lazy" as const };
    const upstreamNoMechanism = { name: "u", base_url: "http://x.test/v1" };
    const choice = await chooseStrategy(route as any, upstreamNoMechanism as any, new CapabilityStore());
    expect(choice.strategy.name).toBe("json-prompted");
  });
});

describe("encode sets the right constraint field", () => {
  test("response_format mode", () => {
    const enc = createConstrainedStrategy("response_format").encode({
      messages: [{ role: "user", content: "weather?" }],
      tools: [WEATHER_TOOL],
    }) as any;
    expect(enc.response_format.type).toBe("json_schema");
    expect(enc.response_format.json_schema.schema.anyOf).toBeDefined();
    expect(enc.tools).toBeUndefined(); // tools folded into the schema/prompt
    expect(enc.stream).toBe(false);
  });

  test("guided_json mode", () => {
    const enc = createConstrainedStrategy("guided_json").encode({
      messages: [{ role: "user", content: "weather?" }],
      tools: [WEATHER_TOOL],
    }) as any;
    expect(enc.guided_json.anyOf).toBeDefined();
    expect(enc.response_format).toBeUndefined();
  });
});

function makeServer(constrained: "response_format" | "guided_json", shim = "constrained") {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "vllm", base_url: upstream.baseUrl, constrained }],
    models: [{ expose: "m", upstream: "vllm", model: "real", shim }],
  });
  const server = createServer(config);
  const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "x" });
  return { server, client };
}

describe("end-to-end constrained decoding", () => {
  test("response_format: foxfence constrains, the server complies, decode yields a clean call", async () => {
    upstream.handler = constrainedHandler("get_weather", { city: "Paris" });
    const { server, client } = makeServer("response_format");
    try {
      const res = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
      });
      expect(fnCall(res)?.name).toBe("get_weather");
      expect(JSON.parse(fnCall(res)!.arguments)).toEqual({ city: "Paris" });
      expect((res as any).foxfence.shim.strategy).toBe("constrained");

      const sent = upstream.requests.at(-1)!.body as any;
      expect(sent.response_format.json_schema.name).toBe("foxfence_tool_call");
    } finally {
      server.stop(true);
    }
  });

  test("guided_json: the vLLM extra field is sent", async () => {
    upstream.handler = constrainedHandler("get_weather", { city: "Berlin" });
    const { server, client } = makeServer("guided_json");
    try {
      const res = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather in Berlin?" }],
        tools: [WEATHER_TOOL],
      });
      expect(fnCall(res)?.name).toBe("get_weather");
      expect(upstream.requests.at(-1)!.body.guided_json).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  test("auto mode prefers constrained over json-prompted when the upstream supports it", async () => {
    upstream.handler = constrainedHandler("get_weather", { city: "Rome" });
    const { server, client } = makeServer("response_format", "auto");
    try {
      const res = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather in Rome?" }],
        tools: [WEATHER_TOOL],
      });
      // probe classified the model non-native → constrained (not json-prompted)
      expect((res as any).foxfence.shim.strategy).toBe("constrained");
      expect(fnCall(res)?.name).toBe("get_weather");
    } finally {
      server.stop(true);
    }
  });
});

describe("config wiring", () => {
  test("shim: constrained without an upstream mechanism is a config error", () => {
    expect(() =>
      ConfigSchema.parse({
        listen: "127.0.0.1:0",
        upstreams: [{ name: "u", base_url: "http://x.test/v1" }],
        models: [{ expose: "m", upstream: "u", model: "real", shim: "constrained" }],
      }),
    ).toThrow(/does not declare a .*constrained/);
  });

  test("invalid YAML config surfaces as ConfigError elsewhere; valid constrained config parses", () => {
    expect(() =>
      ConfigSchema.parse({
        listen: "127.0.0.1:0",
        upstreams: [{ name: "u", base_url: "http://x.test/v1", constrained: "guided_json" }],
        models: [{ expose: "m", upstream: "u", model: "real", shim: "constrained" }],
      }),
    ).not.toThrow();
    expect(ConfigError).toBeDefined();
  });
});
