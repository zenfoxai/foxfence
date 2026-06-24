/** Template-hygiene tests (failure mode: chat-template sensitivity). Unit tests
 * for the pure transforms, plus an integration test that a native-passthrough
 * request honoring a profile's `chatTemplateQuirks` reaches the upstream in the
 * reshaped form. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { applyTemplateQuirks, appliedQuirks } from "../src/template.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

describe("applyTemplateQuirks", () => {
  test("no-system-role folds system into the first user turn", () => {
    const out = applyTemplateQuirks(
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
      ["no-system-role"],
    );
    expect(out.every((m) => m.role !== "system")).toBe(true);
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toBe("Be terse.\n\nhi");
  });

  test("no-system-role creates a user turn when there is none", () => {
    const out = applyTemplateQuirks([{ role: "system", content: "Rules." }], ["no-system-role"]);
    expect(out).toEqual([{ role: "user", content: "Rules." }]);
  });

  test("no-tool-role rewrites tool messages as user turns", () => {
    const out = applyTemplateQuirks(
      [{ role: "tool", tool_call_id: "x", content: "42" }],
      ["no-tool-role"],
    );
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toBe("Tool result: 42");
  });

  test("merge-consecutive coalesces same-role text but preserves tool_calls turns", () => {
    const out = applyTemplateQuirks(
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "2", type: "function", function: { name: "g", arguments: "{}" } }] },
      ],
      ["merge-consecutive"],
    );
    expect(out[0]).toEqual({ role: "user", content: "a\n\nb" });
    // tool-call turns are not merged away
    expect(out.filter((m) => Array.isArray(m.tool_calls)).length).toBe(2);
  });

  test("does not mutate the input array", () => {
    const input = [{ role: "system", content: "x" }, { role: "user", content: "y" }];
    const copy = JSON.parse(JSON.stringify(input));
    applyTemplateQuirks(input, ["no-system-role"]);
    expect(input).toEqual(copy);
  });

  test("appliedQuirks keeps only supported quirks", () => {
    expect(appliedQuirks(["no-system-role", "made-up", "no-tool-role"])).toEqual([
      "no-system-role",
      "no-tool-role",
    ]);
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
  upstream.requests.length = 0;
});

describe("template hygiene pipeline integration", () => {
  test("native passthrough folds the system role per profile quirk", async () => {
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      upstreams: [{ name: "fake", base_url: upstream.baseUrl }],
      models: [
        {
          expose: "m",
          upstream: "fake",
          model: "real",
          profile: { id: "finicky", chatTemplateQuirks: ["no-system-role"] },
        },
      ],
    });
    const server = createServer(config);
    try {
      // No tools → plain passthrough path → template hygiene applies.
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [
            { role: "system", content: "Answer in French." },
            { role: "user", content: "hello" },
          ],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-foxfence-template")).toBe("no-system-role");

      const sent = upstream.requests.at(-1)!.body.messages as Array<Record<string, unknown>>;
      expect(sent.some((m) => m.role === "system")).toBe(false);
      expect(sent[0]!.role).toBe("user");
      expect(String(sent[0]!.content)).toContain("Answer in French.");
    } finally {
      server.stop(true);
    }
  });
});
