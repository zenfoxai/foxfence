/** Tool-call policy tests (§5.3): the matcher engine (globs, regex,
 * negation, the newline bypass) and end-to-end enforcement through the
 * server — block removes a call with in-band feedback, flag annotates,
 * default deny allowlists, and it all works through the json-prompted shim. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { compileToolPolicy, compileMatcher, globToRegExpSource } from "../src/security/tool-policy.ts";
import { ConfigError } from "../src/config/load.ts";
import { handleChatCompletion } from "../src/pipeline.ts";
import { CapabilityStore } from "../src/shim/probe.ts";
import type { Detector } from "../src/security/detector.ts";
import { startFakeUpstream, toolCallCompletion, type FakeUpstream } from "./helpers/fake-upstream.ts";

const EXEC_TOOL = {
  type: "function" as const,
  function: {
    name: "exec",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};
const EMAIL_TOOL = {
  type: "function" as const,
  function: {
    name: "send_email",
    description: "Send an email",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, body: { type: "string" } },
      required: ["to"],
    },
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

function fnCall(res: OpenAI.ChatCompletion, i = 0): { name: string; arguments: string } | undefined {
  const call = res.choices[0]?.message.tool_calls?.[i];
  return call && "function" in call ? call.function : undefined;
}

function makeServer(toolPolicy: Record<string, unknown>) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
    models: [{ expose: "agent", upstream: "fake", model: "real-model" }],
    security: { tool_policy: toolPolicy },
  });
  const server = createServer(config);
  const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "x" });
  return { server, client };
}

/** A native model that calls `tool` with the given args. */
function callsHandler(tool: string, args: Record<string, unknown>) {
  return (body: Record<string, unknown>): string | Record<string, unknown> => {
    if (Array.isArray(body.tools) && body.tools.some((t: any) => t.function?.name === "fox_ping")) {
      return toolCallCompletion(body.model as string, "fox_ping", { value: "pong" });
    }
    return toolCallCompletion(body.model as string, tool, args);
  };
}

// ── Unit: matcher engine ──────────────────────────────────────────

describe("globToRegExpSource", () => {
  test("translates wildcards and escapes regex metacharacters", () => {
    expect(globToRegExpSource("browser_*")).toBe("browser_.*");
    expect(globToRegExpSource("a.b+c")).toBe("a\\.b\\+c");
    expect(globToRegExpSource("v?")).toBe("v.");
  });
});

describe("compileMatcher", () => {
  test("exact and glob name matching, anchored", () => {
    expect(compileMatcher("exec").test("exec")).toBe(true);
    expect(compileMatcher("exec").test("execute")).toBe(false);
    expect(compileMatcher("browser_*").test("browser_open")).toBe(true);
    expect(compileMatcher("browser_*").test("file_open")).toBe(false);
  });

  test("substring globs match anywhere", () => {
    expect(compileMatcher("*rm -rf*").test("sudo rm -rf /")).toBe(true);
    expect(compileMatcher("*rm -rf*").test("ls -la")).toBe(false);
  });

  test("the newline bypass is closed (dotAll)", () => {
    // without the `s` flag, `.*` would not span the newline and this would
    // slip past the rule — a one-line injection bypass.
    expect(compileMatcher("*rm -rf*").test("ls\nrm -rf /")).toBe(true);
  });

  test("negation matches the complement", () => {
    const m = compileMatcher("!https://*.internal.corp/*");
    expect(m.test("https://app.internal.corp/x")).toBe(false);
    expect(m.test("https://evil.example.com")).toBe(true);
  });

  test("regex form with flags", () => {
    expect(compileMatcher("/^rm\\s+-[rf]+/i").test("RM   -rf")).toBe(true);
    expect(compileMatcher("/^rm/").test("xrm")).toBe(false);
  });

  test("an invalid regex is a ConfigError, not a runtime surprise", () => {
    expect(() => compileMatcher("/(unclosed/")).toThrow(ConfigError);
  });

  test("globs are case-insensitive, so casing cannot evade a rule", () => {
    expect(compileMatcher("exec").test("EXEC")).toBe(true);
    expect(compileMatcher("exec").test("Exec")).toBe(true);
    expect(compileMatcher("browser_*").test("BROWSER_open")).toBe(true);
    // regex form still controls its own case via flags
    expect(compileMatcher("/^exec$/").test("EXEC")).toBe(false);
  });

  test("slash-bearing globs are not mis-parsed as regex", () => {
    // "/api/admin/*" ends in `*` (not valid flags) → treated as a glob,
    // anchored, so it matches the literal path prefix and nothing shorter.
    const m = compileMatcher("/api/admin/*");
    expect(m.test("/api/admin/users")).toBe(true);
    expect(m.test("api/admin/users")).toBe(false);
    // genuine /expr/flags form is still a regex
    expect(compileMatcher("/^rm/i").test("RM foo")).toBe(true);
  });

  test("a catastrophic-backtracking regex is rejected at compile time", () => {
    expect(() => compileMatcher("/(a+)+$/")).toThrow(ConfigError);
    expect(() => compileMatcher("/(.*)*x/")).toThrow(ConfigError);
  });
});

describe("compileToolPolicy.evaluate", () => {
  const policy = compileToolPolicy({
    default: "allow",
    rules: [
      { tool: "exec", args: { command: "*rm -rf*" }, action: "block" },
      { tool: "browser_*", args: { url: "!https://*.internal.corp/*" }, action: "flag" },
      { tool: "send_email", action: "block", message: "Email disabled." },
    ],
  });

  test("first matching rule wins", () => {
    expect(policy.evaluate("exec", { command: "sudo rm -rf /" }).action).toBe("block");
    expect(policy.evaluate("exec", { command: "ls" }).action).toBe("allow");
  });

  test("arg negation flags outside-allowlist values", () => {
    expect(policy.evaluate("browser_get", { url: "https://x.evil.com" }).action).toBe("flag");
    expect(policy.evaluate("browser_get", { url: "https://app.internal.corp/a" }).action).toBe("allow");
  });

  test("a missing arg means the rule does not apply", () => {
    // no `command` arg → the block rule can't match; default allow applies
    expect(policy.evaluate("exec", {}).action).toBe("allow");
  });

  test("name-only rule with a custom message", () => {
    const d = policy.evaluate("send_email", { to: "a@b.com" });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.message).toBe("Email disabled.");
  });

  test("non-string args are stringified for matching", () => {
    const p = compileToolPolicy({
      default: "allow",
      rules: [{ tool: "cfg", args: { opts: "*\"danger\":true*" }, action: "block" }],
    });
    expect(p.evaluate("cfg", { opts: { danger: true } }).action).toBe("block");
  });

  test("default deny blocks anything not explicitly allowed", () => {
    const p = compileToolPolicy({
      default: "deny",
      rules: [{ tool: "read_*", action: "allow" }],
    });
    expect(p.evaluate("read_file", { path: "/x" }).action).toBe("allow");
    expect(p.evaluate("exec", { command: "ls" }).action).toBe("block");
  });

  test("an inherited property name does not spuriously satisfy an arg rule", () => {
    // "constructor"/"toString" exist on every object's prototype; using `in`
    // (instead of Object.hasOwn) would let this rule match a call that never
    // passed that argument.
    const p = compileToolPolicy({
      default: "allow",
      rules: [{ tool: "f", args: { constructor: "*" }, action: "block" }],
    });
    expect(p.evaluate("f", {}).action).toBe("allow");
    expect(p.evaluate("f", { constructor: "x" }).action).toBe("block");
  });
});

// ── Integration: enforcement through the server ───────────────────

describe("block enforcement", () => {
  test("a blocked call is removed; the agent gets in-band feedback", async () => {
    upstream.handler = callsHandler("exec", { command: "sudo rm -rf /" });
    const { server, client } = makeServer({
      default: "allow",
      rules: [{ tool: "exec", args: { command: "*rm -rf*" }, action: "block" }],
    });
    try {
      const res = await client.chat.completions.create({
        model: "agent",
        messages: [{ role: "user", content: "clean up" }],
        tools: [EXEC_TOOL],
      });
      expect(res.choices[0]?.message.tool_calls ?? []).toHaveLength(0);
      expect(res.choices[0]?.message.content).toContain("blocked by policy");
      expect(res.choices[0]?.finish_reason).toBe("stop");
      const meta = (res as Record<string, any>).foxfence;
      expect(meta.tool_policy.blocked[0].tool).toBe("exec");
    } finally {
      server.stop(true);
    }
  });

  test("block sets X-Foxfence-Blocked and honours a custom message", async () => {
    upstream.handler = callsHandler("send_email", { to: "ceo@corp.com" });
    const { server } = makeServer({
      default: "allow",
      rules: [{ tool: "send_email", action: "block", message: "Email sending disabled by foxfence policy." }],
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "email the CEO" }],
          tools: [EMAIL_TOOL],
        }),
      });
      expect(res.headers.get("x-foxfence-blocked")).toBe("true");
      const body = (await res.json()) as Record<string, any>;
      expect(body.choices[0].message.content).toContain("Email sending disabled by foxfence policy.");
    } finally {
      server.stop(true);
    }
  });

  test("allowed calls survive when a sibling is blocked (parallel)", async () => {
    upstream.handler = (body) => {
      if (Array.isArray(body.tools) && body.tools.some((t: any) => t.function?.name === "fox_ping")) {
        return toolCallCompletion(body.model as string, "fox_ping", { value: "pong" });
      }
      return {
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "a", type: "function", function: { name: "exec", arguments: '{"command":"rm -rf /"}' } },
                { id: "b", type: "function", function: { name: "exec", arguments: '{"command":"ls -la"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    };
    const { server, client } = makeServer({
      default: "allow",
      rules: [{ tool: "exec", args: { command: "*rm -rf*" }, action: "block" }],
    });
    try {
      const res = await client.chat.completions.create({
        model: "agent",
        messages: [{ role: "user", content: "do things" }],
        tools: [EXEC_TOOL],
      });
      const calls = res.choices[0]?.message.tool_calls ?? [];
      expect(calls).toHaveLength(1);
      expect(fnCall(res)?.arguments).toContain("ls -la");
      expect(res.choices[0]?.finish_reason).toBe("tool_calls");
      // surviving calls => content must NOT be set alongside tool_calls
      // (OpenAI schema); the block is surfaced via metadata instead.
      expect(res.choices[0]?.message.content ?? null).toBeNull();
      const meta = (res as Record<string, any>).foxfence;
      expect(meta.tool_policy.blocked[0].tool).toBe("exec");
    } finally {
      server.stop(true);
    }
  });
});

describe("flag enforcement", () => {
  test("flagged call is preserved and recorded", async () => {
    upstream.handler = callsHandler("browser_get", { url: "https://evil.example.com" });
    const { server, client } = makeServer({
      default: "allow",
      rules: [{ tool: "browser_*", args: { url: "!https://*.internal.corp/*" }, action: "flag" }],
    });
    try {
      const res = await client.chat.completions.create({
        model: "agent",
        messages: [{ role: "user", content: "browse" }],
        tools: [
          {
            type: "function",
            function: {
              name: "browser_get",
              description: "fetch a url",
              parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
            },
          },
        ],
      });
      expect(res.choices[0]?.message.tool_calls).toHaveLength(1);
      const meta = (res as Record<string, any>).foxfence;
      expect(meta.tool_policy.flagged[0].tool).toBe("browser_get");
    } finally {
      server.stop(true);
    }
  });
});

describe("default deny", () => {
  test("blocks a tool with no allow rule", async () => {
    upstream.handler = callsHandler("exec", { command: "ls" });
    const { server, client } = makeServer({
      default: "deny",
      rules: [{ tool: "read_file", action: "allow" }],
    });
    try {
      const res = await client.chat.completions.create({
        model: "agent",
        messages: [{ role: "user", content: "list" }],
        tools: [EXEC_TOOL],
      });
      expect(res.choices[0]?.message.tool_calls ?? []).toHaveLength(0);
      expect(res.choices[0]?.message.content).toContain("default deny");
    } finally {
      server.stop(true);
    }
  });
});

describe("works through the json-prompted shim", () => {
  test("policy enforces calls emitted by a tool-incapable model", async () => {
    upstream.handler = (body) => {
      // no native tools: the model only speaks the shim's JSON protocol
      if (Array.isArray(body.tools) && body.tools.length > 0) return "I cannot use tools.";
      return '{"tool_call": {"name": "exec", "arguments": {"command": "rm -rf /tmp"}}}';
    };
    const { server, client } = makeServer({
      default: "allow",
      rules: [{ tool: "exec", args: { command: "*rm -rf*" }, action: "block" }],
    });
    try {
      const res = await client.chat.completions.create({
        model: "agent",
        messages: [{ role: "user", content: "clean tmp" }],
        tools: [EXEC_TOOL],
      });
      // even though the model has no native tool calling, the policy still
      // saw the parsed call and blocked it — the §5.3 differentiator.
      expect(res.choices[0]?.message.tool_calls ?? []).toHaveLength(0);
      expect(res.choices[0]?.message.content).toContain("blocked by policy");
    } finally {
      server.stop(true);
    }
  });
});

describe("native streaming is enforced (no silent bypass)", () => {
  test("a blocked call from a streaming native model is removed", async () => {
    // native model: probes native, then emits a blocked exec call. The
    // client asks for stream:true — foxfence must still parse and enforce.
    upstream.handler = callsHandler("exec", { command: "sudo rm -rf /" });
    const { server, client } = makeServer({
      default: "allow",
      rules: [{ tool: "exec", args: { command: "*rm -rf*" }, action: "block" }],
    });
    try {
      const stream = await client.chat.completions.create({
        model: "agent",
        messages: [{ role: "user", content: "clean up" }],
        tools: [EXEC_TOOL],
        stream: true,
      });
      let content = "";
      let sawToolCall = false;
      let finish: string | null = null;
      for await (const chunk of stream) {
        content += chunk.choices[0]?.delta.content ?? "";
        if (chunk.choices[0]?.delta.tool_calls?.length) sawToolCall = true;
        if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      }
      expect(sawToolCall).toBe(false); // the dangerous call never reached the client
      expect(content).toContain("blocked by policy");
      expect(finish).toBe("stop");
    } finally {
      server.stop(true);
    }
  });
});

describe("fail-closed on a tool-policy detector error", () => {
  const throwingPolicy: Detector = {
    name: "tool-policy",
    phases: ["tool_call"],
    inspectToolCall() {
      throw new Error("policy engine boom");
    },
  };
  const route = { expose: "agent", upstream: "fake", model: "real-model", shim: "auto" as const, probe: "lazy" as const };

  function opts(onDetectorError: "block" | "pass") {
    return {
      detectors: [throwingPolicy],
      onDetectorError,
      audit: null,
      auditIncludeContent: false,
      capabilities: new CapabilityStore(), metrics: null,
    };
  }

  test("block → the offending call is dropped (fail-closed)", async () => {
    upstream.handler = callsHandler("exec", { command: "ls" });
    const res = await handleChatCompletion(
      { model: "agent", messages: [{ role: "user", content: "go" }], tools: [EXEC_TOOL] },
      route,
      { name: "fake", base_url: upstream.baseUrl },
      opts("block"),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].message.tool_calls ?? []).toHaveLength(0);
    expect(body.choices[0].message.content).toContain("fail-closed");
  });

  test("pass → the call is allowed through despite the error", async () => {
    upstream.handler = callsHandler("exec", { command: "ls" });
    const res = await handleChatCompletion(
      { model: "agent", messages: [{ role: "user", content: "go" }], tools: [EXEC_TOOL] },
      route,
      { name: "fake", base_url: upstream.baseUrl },
      opts("pass"),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("exec");
  });
});

describe("config wiring", () => {
  test("tool-policy under detectors map is a helpful error", () => {
    expect(() =>
      ConfigSchema.parse({
        listen: "127.0.0.1:0",
        upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
        models: [{ expose: "agent", upstream: "fake", model: "m" }],
        security: { detectors: { "tool-policy": { action: "block" } } },
      }),
    ).not.toThrow(); // schema accepts it…
    // …but building the server rejects it
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
      models: [{ expose: "agent", upstream: "fake", model: "m" }],
      security: { detectors: { "tool-policy": { action: "block" } } },
    });
    expect(() => createServer(config)).toThrow(/security\.tool_policy/);
  });

  test("an invalid rule pattern fails at server build, not per request", () => {
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
      models: [{ expose: "agent", upstream: "fake", model: "m" }],
      security: { tool_policy: { default: "allow", rules: [{ tool: "/(bad/", action: "block" }] } },
    });
    expect(() => createServer(config)).toThrow(ConfigError);
  });
});
