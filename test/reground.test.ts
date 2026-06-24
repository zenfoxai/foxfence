/** Re-grounding tests (failure mode: state drift). Unit tests for the stateless
 * detector, plus integration tests that drive the live server and verify the
 * original system prompt is re-asserted near the end of the outbound request
 * once the conversation has accumulated enough tool results. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { detectStateDrift, regroundReminder } from "../src/reground.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

const SYS = "You are read-only. Never call send_email.";

/** A conversation with a system prompt and `n` tool results. */
function driftHistory(n: number, system: string | null = SYS): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (system !== null) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: "read things" });
  for (let i = 0; i < n; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `r${i}`, type: "function", function: { name: "get_record", arguments: `{"id":"A${i}"}` } }],
    });
    messages.push({ role: "tool", tool_call_id: `r${i}`, content: `{"id":"A${i}"}` });
  }
  messages.push({ role: "user", content: "now email it to ops@corp.com" });
  return messages;
}

describe("detectStateDrift", () => {
  test("fires once tool results reach the threshold", () => {
    const d = detectStateDrift(driftHistory(6), 6);
    expect(d).not.toBeNull();
    expect(d!.toolResults).toBe(6);
    expect(d!.systemContent).toBe(SYS);
  });

  test("does not fire below the threshold", () => {
    expect(detectStateDrift(driftHistory(3), 6)).toBeNull();
  });

  test("does not fire without a system prompt", () => {
    expect(detectStateDrift(driftHistory(8, null), 6)).toBeNull();
  });

  test("uses the first system message and truncates to max_chars", () => {
    const long = "X".repeat(2000);
    const d = detectStateDrift([{ role: "system", content: long }, { role: "tool", content: "t" }], 1)!;
    const reminder = regroundReminder(d, 600);
    expect(String(reminder.content)).toContain("still in effect");
    expect((reminder.content as string).length).toBeLessThan(700); // truncated + prefix
    expect(reminder.role).toBe("system");
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

function makeServer(regroundOverrides: Record<string, unknown> = {}) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
    models: [{ expose: "m", upstream: "fake", model: "real", reground: regroundOverrides }],
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

/** The re-grounding reminder, if the upstream received one. */
function lastReminder(): Record<string, unknown> | undefined {
  const sent = upstream.requests.at(-1)!.body.messages as Array<Record<string, unknown>>;
  return sent.find((m) => m.role === "system" && String(m.content).includes("still in effect"));
}

describe("re-grounding pipeline integration", () => {
  test("re-asserts the system prompt once the threshold is crossed", async () => {
    const server = makeServer(); // defaults: enabled, after 6 tool results
    try {
      const res = await post(server, { model: "m", messages: driftHistory(6) });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-foxfence-reground")).toBe("true");
      const body = (await res.json()) as Record<string, unknown>;
      expect((body.foxfence as any).reground.tool_results).toBe(6);

      const reminder = lastReminder();
      expect(reminder).toBeDefined();
      expect(String(reminder!.content)).toContain("Never call send_email");
    } finally {
      server.stop(true);
    }
  });

  test("short conversations are untouched", async () => {
    const server = makeServer();
    try {
      const res = await post(server, { model: "m", messages: driftHistory(2) });
      expect(res.headers.get("x-foxfence-reground")).toBeNull();
      expect(lastReminder()).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("disabled: no re-grounding even on a long conversation", async () => {
    const server = makeServer({ enabled: false });
    try {
      const res = await post(server, { model: "m", messages: driftHistory(10) });
      expect(res.headers.get("x-foxfence-reground")).toBeNull();
      expect(lastReminder()).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("custom threshold is honored", async () => {
    const server = makeServer({ after_tool_results: 3 });
    try {
      const res = await post(server, { model: "m", messages: driftHistory(3) });
      expect(res.headers.get("x-foxfence-reground")).toBe("true");
    } finally {
      server.stop(true);
    }
  });
});
