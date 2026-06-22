/** End-to-end pipeline tests: detectors, mask & restore, fail-closed
 * behavior, blocked responses, and the audit trail. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { handleChatCompletion } from "../src/pipeline.ts";
import { CapabilityStore } from "../src/shim/probe.ts";
import type { Detector } from "../src/security/detector.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GH_TOKEN = "ghp_abcDEF123456789012345678901234567890";

let upstream: FakeUpstream;
let tmp: string;
let auditFile: string;

beforeAll(() => {
  upstream = startFakeUpstream();
  tmp = mkdtempSync(join(tmpdir(), "foxfence-test-"));
  auditFile = join(tmp, "audit.jsonl");
});

afterAll(() => {
  upstream.stop();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  upstream.mode = "fixed";
  upstream.reply = "Hello from the fake model.";
});

function makeServer(security?: Record<string, unknown>) {
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
    models: [{ expose: "guarded", upstream: "fake", model: "real-model" }],
    security,
    audit: { file: auditFile },
  });
  const server = createServer(config);
  const client = new OpenAI({
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "unused",
  });
  return { server, client };
}

function lastAuditRecord(): Record<string, unknown> {
  const lines = readFileSync(auditFile, "utf8").trim().split("\n");
  return JSON.parse(lines.at(-1)!);
}

describe("mask & restore round-trip", () => {
  test("upstream sees a placeholder, the agent gets the original back", async () => {
    const { server, client } = makeServer();
    try {
      upstream.mode = "echo";
      const res = await client.chat.completions.create({
        model: "guarded",
        messages: [{ role: "user", content: `my key is ${AWS_KEY}, store it` }],
      });

      const seenUpstream = upstream.requests.at(-1)!.body.messages as Array<{ content: string }>;
      expect(seenUpstream[0]!.content).not.toContain(AWS_KEY);
      expect(seenUpstream[0]!.content).toMatch(/__fox_secret_\d+__/);

      // the echo comes back restored
      expect(res.choices[0]?.message.content).toContain(AWS_KEY);

      const record = lastAuditRecord();
      expect(record.masked).toBe(1);
      expect(record.restored).toBe(1);
      // audit must never contain the secret itself
      expect(JSON.stringify(record)).not.toContain(AWS_KEY);
    } finally {
      server.stop(true);
    }
  });

  test("a new secret in the model output is permanently redacted", async () => {
    const { server, client } = makeServer();
    try {
      upstream.reply = `sure, use this token: ${GH_TOKEN}`;
      const res = await client.chat.completions.create({
        model: "guarded",
        messages: [{ role: "user", content: "give me a token" }],
      });
      expect(res.choices[0]?.message.content).toContain("[REDACTED:github-token]");
      expect(res.choices[0]?.message.content).not.toContain(GH_TOKEN);
    } finally {
      server.stop(true);
    }
  });

  test("model name is normalized to the exposed name in non-stream responses", async () => {
    const { server, client } = makeServer();
    try {
      const res = await client.chat.completions.create({
        model: "guarded",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.model).toBe("guarded");
    } finally {
      server.stop(true);
    }
  });
});

describe("block actions", () => {
  test("secrets action block → content_filter + X-Foxfence-Blocked, never reaches upstream", async () => {
    const { server } = makeServer({ detectors: { secrets: { action: "block" } } });
    try {
      const before = upstream.requests.length;
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "guarded",
          messages: [{ role: "user", content: `deploy with ${AWS_KEY}` }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-foxfence-blocked")).toBe("true");
      const body = (await res.json()) as Record<string, any>;
      expect(body.choices[0].finish_reason).toBe("content_filter");
      expect(body.foxfence.blocked).toBe(true);
      expect(upstream.requests.length).toBe(before);

      expect(lastAuditRecord().blocked).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("flag actions and metadata", () => {
  test("pii-basic flags without altering traffic, verdict lands in foxfence metadata", async () => {
    const { server, client } = makeServer();
    try {
      const content = "email bob@example.com about the launch";
      const res = await client.chat.completions.create({
        model: "guarded",
        messages: [{ role: "user", content }],
      });
      const seenUpstream = upstream.requests.at(-1)!.body.messages as Array<{ content: string }>;
      expect(seenUpstream[0]!.content).toBe(content);

      const meta = (res as Record<string, any>).foxfence;
      expect(meta.verdicts).toEqual([
        expect.objectContaining({ detector: "pii-basic", action: "flag" }),
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("clean requests carry no foxfence metadata", async () => {
    const { server, client } = makeServer();
    try {
      const res = await client.chat.completions.create({
        model: "guarded",
        messages: [{ role: "user", content: "write a haiku" }],
      });
      expect((res as Record<string, any>).foxfence).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("detectors can be disabled with action off", async () => {
    const { server, client } = makeServer({ detectors: { "pii-basic": { action: "off" } } });
    try {
      const res = await client.chat.completions.create({
        model: "guarded",
        messages: [{ role: "user", content: "email bob@example.com" }],
      });
      expect((res as Record<string, any>).foxfence).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

describe("streaming applies mask & restore incrementally", () => {
  test("a masked secret is restored in the streamed response", async () => {
    const { server, client } = makeServer();
    try {
      upstream.mode = "echo";
      const stream = await client.chat.completions.create({
        model: "guarded",
        messages: [{ role: "user", content: `key ${AWS_KEY} end` }],
        stream: true,
      });
      let assembled = "";
      for await (const chunk of stream) {
        assembled += chunk.choices[0]?.delta.content ?? "";
      }
      // the upstream saw a placeholder; the agent gets its own key back…
      expect(assembled).toContain(AWS_KEY);
      // …and never sees the internal placeholder
      expect(assembled).not.toMatch(/__fox_secret_\d+__/);
      const record = lastAuditRecord();
      expect(record.stream).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("fail-closed on detector errors", () => {
  const throwingDetector: Detector = {
    name: "broken",
    phases: ["request"],
    inspect() {
      throw new Error("boom");
    },
  };
  const route = {
    expose: "guarded",
    upstream: "fake",
    model: "real-model",
    shim: "auto" as const,
    probe: "lazy" as const,
  };
  const baseOpts = { audit: null, auditIncludeContent: false, capabilities: new CapabilityStore() };

  test("on_detector_error block → request is blocked", async () => {
    const res = await handleChatCompletion(
      { model: "guarded", messages: [{ role: "user", content: "hi" }] },
      route,
      { name: "fake", base_url: upstream.baseUrl },
      { ...baseOpts, detectors: [throwingDetector], onDetectorError: "block" },
    );
    expect(res.headers.get("x-foxfence-blocked")).toBe("true");
    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].finish_reason).toBe("content_filter");
    expect(body.foxfence.reason).toContain("fail-closed");
  });

  test("on_detector_error pass → request goes through", async () => {
    const res = await handleChatCompletion(
      { model: "guarded", messages: [{ role: "user", content: "hi" }] },
      route,
      { name: "fake", base_url: upstream.baseUrl },
      { ...baseOpts, detectors: [throwingDetector], onDetectorError: "pass" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].message.content).toBe("Hello from the fake model.");
  });
});

describe("config handling", () => {
  test("unknown detector name is a startup error", () => {
    expect(() => makeServer({ detectors: { secrits: { action: "mask" } } })).toThrow(
      /unknown detector "secrits"/,
    );
  });

  test("spec §7 detectors that are not implemented yet are tolerated", () => {
    const { server } = makeServer({
      detectors: { "prompt-injection": { action: "flag" } },
    });
    server.stop(true);
  });
});
