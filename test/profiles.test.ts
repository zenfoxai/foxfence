/** Model profile tests (§6.1): registry loading/resolution, capability
 * overrides that skip the probe, strategy pinning, and the no-system-role
 * chat-template quirk. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { ConfigError } from "../src/config/load.ts";
import { loadProfileRegistry, resolveProfiles } from "../src/config/profiles.ts";
import { injectToolBlock } from "../src/shim/json-prompted.ts";
import { startFakeUpstream, toolCallCompletion, type FakeUpstream } from "./helpers/fake-upstream.ts";

const WEATHER_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

let upstream: FakeUpstream;
let tmp: string;

beforeAll(() => {
  upstream = startFakeUpstream();
  tmp = mkdtempSync(join(tmpdir(), "foxfence-profiles-"));
  writeFileSync(
    join(tmp, "models.yaml"),
    `- id: native-model
  capabilities: { toolCalling: native }
- id: legacy-no-system
  pinStrategy: json-prompted
  chatTemplateQuirks: [no-system-role]
- id: pinned-constrained
  pinStrategy: constrained
`,
  );
});

afterAll(() => {
  upstream.stop();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  upstream.handler = null;
  upstream.mode = "fixed";
});

function nativeHandler(body: Record<string, unknown>) {
  const tools = body.tools as Array<{ function: { name: string } }> | undefined;
  if (tools && tools.length > 0) {
    const name = tools[0]!.function.name;
    return toolCallCompletion(body.model as string, name, name === "fox_ping" ? { value: "pong" } : { city: "Paris" });
  }
  return "plain";
}

describe("registry loading and resolution", () => {
  test("loads profiles by id", () => {
    const reg = loadProfileRegistry(tmp);
    expect(reg.get("native-model")?.capabilities?.toolCalling).toBe("native");
    expect(reg.get("legacy-no-system")?.chatTemplateQuirks).toEqual(["no-system-role"]);
  });

  test("a missing directory is an empty registry, not an error", () => {
    expect(loadProfileRegistry(join(tmp, "does-not-exist")).size).toBe(0);
  });

  test("resolveProfiles maps a route's string id to the profile", () => {
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      profiles_dir: tmp,
      upstreams: [{ name: "u", base_url: "http://x.test/v1" }],
      models: [{ expose: "m", upstream: "u", model: "real", profile: "native-model" }],
    });
    const resolved = resolveProfiles(config);
    expect(resolved.get("m")?.capabilities?.toolCalling).toBe("native");
  });

  test("an unknown profile id is a ConfigError", () => {
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      profiles_dir: tmp,
      upstreams: [{ name: "u", base_url: "http://x.test/v1" }],
      models: [{ expose: "m", upstream: "u", model: "real", profile: "nope" }],
    });
    expect(() => resolveProfiles(config)).toThrow(ConfigError);
  });

  test("an inline profile object is used directly (no registry needed)", () => {
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      upstreams: [{ name: "u", base_url: "http://x.test/v1" }],
      models: [
        { expose: "m", upstream: "u", model: "real", profile: { pinStrategy: "json-prompted" } },
      ],
    });
    expect(resolveProfiles(config).get("m")?.pinStrategy).toBe("json-prompted");
  });

  test("a STRING profile pinning constrained without an upstream mechanism is rejected", () => {
    // the parse-time schema check can't see string profiles (resolved later),
    // so resolveProfiles must catch it — otherwise a bogus response_format
    // would be sent to a server that can't honour it.
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      profiles_dir: tmp,
      upstreams: [{ name: "u", base_url: "http://x.test/v1" }], // no constrained
      models: [{ expose: "m", upstream: "u", model: "real", profile: "pinned-constrained" }],
    });
    expect(() => resolveProfiles(config)).toThrow(/constrained/);
  });

  test("the same profile resolves fine when the upstream declares a mechanism", () => {
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      profiles_dir: tmp,
      upstreams: [{ name: "u", base_url: "http://x.test/v1", constrained: "guided_json" }],
      models: [{ expose: "m", upstream: "u", model: "real", profile: "pinned-constrained" }],
    });
    expect(resolveProfiles(config).get("m")?.pinStrategy).toBe("constrained");
  });
});

describe("bundled profile registry", () => {
  test("ships a Cohere Command A+ profile that does NOT pin native tool calling", () => {
    // Validated against cohere/command-a via OpenRouter: it does not emit
    // OpenAI-format native tool_calls, so pinning native would force 0%. The
    // profile is informational; tool calling is left to `shim: auto`.
    const reg = loadProfileRegistry("./profiles");
    const cmd = reg.get("command-a-plus");
    expect(cmd).toBeDefined();
    expect(cmd!.capabilities?.toolCalling).toBeUndefined();
    expect(cmd!.pinStrategy).toBeUndefined();
    expect(cmd!.contextWindow).toBe(256000);
  });

  test("a route referencing command-a-plus still probes (auto), not forced native", async () => {
    // the model is a native-tool-caller in this fake, so the probe classifies
    // native — but the point is the probe RAN (the profile didn't pin it).
    upstream.handler = nativeHandler;
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      profiles_dir: "./profiles",
      upstreams: [{ name: "cohere", base_url: upstream.baseUrl }],
      models: [{ expose: "command", upstream: "cohere", model: "command-a-plus", profile: "command-a-plus" }],
    });
    const server = createServer(config);
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "x" });
    try {
      const before = upstream.requests.length;
      const res = await client.chat.completions.create({
        model: "command",
        messages: [{ role: "user", content: "weather?" }],
        tools: [WEATHER_TOOL],
      });
      // a fox_ping probe WAS sent (capabilities not declared by the profile)
      expect(upstream.requests.slice(before).some((r) => JSON.stringify(r.body).includes("fox_ping"))).toBe(true);
      expect((res as any).foxfence.shim.source).toBe("probe");
    } finally {
      server.stop(true);
    }
  });
});

describe("injectToolBlock (no-system-role quirk)", () => {
  test("default places the block in a system message", () => {
    const out = injectToolBlock([{ role: "user", content: "hi" }], "TOOLS", false);
    expect(out[0]!.role).toBe("system");
  });

  test("no-system-role merges the block into the first user message", () => {
    const out = injectToolBlock([{ role: "user", content: "hi" }], "TOOLS", true);
    expect(out.some((m) => m.role === "system")).toBe(false);
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toContain("TOOLS");
    expect(out[0]!.content).toContain("hi");
  });
});

function makeServer(profile: unknown) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    profiles_dir: tmp,
    upstreams: [{ name: "u", base_url: upstream.baseUrl }],
    models: [{ expose: "m", upstream: "u", model: "real", profile }],
  });
  const server = createServer(config);
  const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "x" });
  return { server, client };
}

describe("profile behavior end-to-end", () => {
  test("capabilities: native skips the probe entirely", async () => {
    upstream.handler = nativeHandler;
    const { server, client } = makeServer("native-model");
    try {
      const before = upstream.requests.length;
      const res = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather?" }],
        tools: [WEATHER_TOOL],
      });
      // no fox_ping probe was sent — the profile declared native
      expect(upstream.requests.slice(before).some((r) => JSON.stringify(r.body).includes("fox_ping"))).toBe(false);
      expect((res as any).foxfence.shim.strategy).toBe("native");
      expect((res as any).foxfence.shim.source).toBe("profile");
    } finally {
      server.stop(true);
    }
  });

  test("no-system-role profile shims via json-prompted without a system message", async () => {
    upstream.handler = (b) => {
      if (Array.isArray(b.tools) && b.tools.length > 0) return "no native tools";
      return '{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}';
    };
    const { server, client } = makeServer("legacy-no-system");
    try {
      await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
      });
      const sent = upstream.requests.at(-1)!.body.messages as Array<{ role: string; content: string }>;
      expect(sent.some((m) => m.role === "system")).toBe(false);
      expect(sent[0]!.role).toBe("user");
      expect(sent[0]!.content).toContain("Available tools");
    } finally {
      server.stop(true);
    }
  });
});
