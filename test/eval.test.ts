/** Tests for the eval harness (§11.2): corpus validation, the scorer, the
 * simulated weak model, and the end-to-end direct-vs-foxfence run. */

import { describe, expect, test } from "bun:test";
import { validateCase, normalize, loadCorpus, type RawCase } from "../eval/corpus.ts";
import { scoreCase, aggregate } from "../eval/score.ts";
import { runEval } from "../eval/run.ts";

const WEATHER_CASE: RawCase = {
  id: "t-weather",
  category: "simple",
  description: "weather",
  user: "What's the weather in Paris?",
  tools: [
    {
      name: "get_weather",
      description: "weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" }, unit: { type: "string", enum: ["c", "f"] } },
        required: ["city"],
      },
    },
  ],
  expect: { type: "tool_call", name: "get_weather", args: { city: "Paris" } },
};

describe("validateCase", () => {
  test("accepts a well-formed case", () => {
    expect(validateCase(WEATHER_CASE)).toEqual([]);
  });

  test("rejects an expected tool not among the tools", () => {
    const bad = { ...WEATHER_CASE, expect: { type: "tool_call", name: "nope" } } as RawCase;
    expect(validateCase(bad)[0]).toContain("not among the declared tools");
  });

  test("rejects an expected arg that violates the schema", () => {
    const bad = {
      ...WEATHER_CASE,
      expect: { type: "tool_call", name: "get_weather", args: { unit: "kelvin" } },
    } as RawCase;
    expect(validateCase(bad).join()).toContain("enum");
  });

  test("rejects an expected arg key not in the schema", () => {
    const bad = {
      ...WEATHER_CASE,
      expect: { type: "tool_call", name: "get_weather", args: { country: "FR" } },
    } as RawCase;
    expect(validateCase(bad).join()).toContain('unknown property "country"');
  });

  test("partial args (subset of required) are allowed", () => {
    // only `city` pinned even though that's fine; the point is we don't force
    // every required key into the expectation
    expect(validateCase(WEATHER_CASE)).toEqual([]);
  });
});

describe("the shipped corpus is all valid", () => {
  test("loadCorpus reports zero skipped cases", () => {
    const { cases, skipped } = loadCorpus();
    expect(skipped).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
});

describe("scoreCase", () => {
  const c = normalize(WEATHER_CASE);

  test("a correct, schema-valid call to the right tool is a valid+exact match", () => {
    const body = {
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [{ function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
          },
        },
      ],
    };
    const s = scoreCase(c, body);
    expect(s.validCall).toBe(true);
    expect(s.exactMatch).toBe(true);
  });

  test("wrong argument value → valid call but not an exact match", () => {
    const body = {
      choices: [{ message: { tool_calls: [{ function: { name: "get_weather", arguments: '{"city":"Berlin"}' } }] } }],
    };
    const s = scoreCase(c, body);
    expect(s.validCall).toBe(true);
    expect(s.exactMatch).toBe(false);
  });

  test("schema-invalid args → not a valid call", () => {
    const body = {
      choices: [{ message: { tool_calls: [{ function: { name: "get_weather", arguments: '{"unit":"kelvin"}' } }] } }],
    };
    expect(scoreCase(c, body).validCall).toBe(false);
  });

  test("plain text instead of a call → fail for a tool_call case", () => {
    const body = { choices: [{ message: { role: "assistant", content: "It's sunny." } }] };
    expect(scoreCase(c, body).validCall).toBe(false);
  });

  test("nested-object args match regardless of key order", () => {
    const nested = normalize({
      id: "nest",
      category: "x",
      description: "",
      user: "mark home",
      tools: [
        {
          name: "mark",
          description: "",
          parameters: {
            type: "object",
            properties: { at: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" } } } },
            required: ["at"],
          },
        },
      ],
      expect: { type: "tool_call", name: "mark", args: { at: { lat: 1, lng: 2 } } },
    } as RawCase);
    // produced args spell the nested object's keys in the opposite order
    const body = {
      choices: [{ message: { tool_calls: [{ function: { name: "mark", arguments: '{"at":{"lng":2,"lat":1}}' } }] } }],
    };
    expect(scoreCase(nested, body).exactMatch).toBe(true);
  });

  test("no_call case passes only when no tool is called", () => {
    const noCall = normalize({ ...WEATHER_CASE, id: "n", expect: { type: "no_call" } } as RawCase);
    expect(scoreCase(noCall, { choices: [{ message: { content: "hi" } }] }).validCall).toBe(true);
    expect(
      scoreCase(noCall, {
        choices: [{ message: { tool_calls: [{ function: { name: "get_weather", arguments: "{}" } }] } }],
      }).validCall,
    ).toBe(false);
  });
});

describe("aggregate", () => {
  test("computes per-bucket rates", () => {
    const scores = [
      { id: "a", category: "x", expectType: "tool_call", producedToolCall: true, correctTool: true, validArgs: true, schemaValid: true, argsMatch: true, validCall: true, exactMatch: true },
      { id: "b", category: "x", expectType: "tool_call", producedToolCall: false, correctTool: false, validArgs: false, schemaValid: false, argsMatch: false, validCall: false, exactMatch: false },
      { id: "c", category: "x", expectType: "no_call", producedToolCall: false, correctTool: false, validArgs: false, schemaValid: false, argsMatch: false, validCall: true, exactMatch: true },
    ] as const;
    const a = aggregate(scores as any);
    expect(a.toolCases).toBe(2);
    expect(a.toolValidRate).toBe(0.5);
    expect(a.noCallCases).toBe(1);
    expect(a.noCallCorrectRate).toBe(1);
  });
});

describe("end-to-end: foxfence beats direct on the simulated weak model", () => {
  test("the shim recovers tool calls the raw model emits as text", async () => {
    const result = await runEval();
    const direct = result.rows.find((r) => r.mode === "direct")!;
    const fox = result.rows.find((r) => r.mode === "foxfence")!;

    // the weak model has no native tool calling → ~0% direct on tool cases
    expect(direct.agg.toolValidRate).toBeLessThan(0.1);
    // foxfence's json-prompted shim + repair recover most of them
    expect(fox.agg.toolValidRate).toBeGreaterThan(0.7);
    // and it does so without breaking the no-call cases
    expect(fox.agg.noCallCorrectRate).toBe(1);
    // the repair loop fired for the truncated-JSON cases
    expect(fox.totalRepairs).toBeGreaterThan(0);
  }, 20_000);
});
