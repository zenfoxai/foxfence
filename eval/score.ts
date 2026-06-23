import { validateAgainstSchema } from "../src/shim/args-validate.ts";
import type { EvalCase } from "./corpus.ts";

/** Per-case scoring against the model's (or foxfence's) OpenAI response.
 *
 * The headline metric is `validCall` — "did the right thing": for a tool_call
 * case it means the model produced a schema-valid call to the correct tool;
 * for a no_call case it means it (correctly) produced no tool call.
 * `exactMatch` additionally requires the expected argument values. */
export interface CaseScore {
  id: string;
  category: string;
  expectType: "tool_call" | "no_call" | "avoid_repeat";
  producedToolCall: boolean;
  correctTool: boolean;
  validArgs: boolean;
  schemaValid: boolean;
  argsMatch: boolean;
  validCall: boolean;
  exactMatch: boolean;
}

function firstToolCall(
  body: Record<string, unknown>,
): { name: string; args: string } | null {
  const message = (body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
    | Record<string, unknown>
    | undefined;
  const calls = message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const fn = (calls[0] as Record<string, unknown>).function as Record<string, unknown> | undefined;
  return { name: String(fn?.name ?? ""), args: typeof fn?.arguments === "string" ? fn.arguments : "" };
}

/** Picks the produced call matching the expected tool name, else the first. */
function matchingCall(
  body: Record<string, unknown>,
  expectedName: string,
): { name: string; args: string } | null {
  const message = (body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
    | Record<string, unknown>
    | undefined;
  const calls = message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const named = calls.find(
    (c) => ((c as Record<string, unknown>).function as Record<string, unknown>)?.name === expectedName,
  );
  const chosen = (named ?? calls[0]) as Record<string, unknown>;
  const fn = chosen.function as Record<string, unknown> | undefined;
  return { name: String(fn?.name ?? ""), args: typeof fn?.arguments === "string" ? fn.arguments : "" };
}

/** Structural equality — key-order-independent for objects (JSON.stringify
 * would spuriously fail {a,b} vs {b,a}), order-sensitive for arrays. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

export function scoreCase(c: EvalCase, body: Record<string, unknown>): CaseScore {
  const base: CaseScore = {
    id: c.id,
    category: c.category,
    expectType: c.expect.type,
    producedToolCall: firstToolCall(body) !== null,
    correctTool: false,
    validArgs: false,
    schemaValid: false,
    argsMatch: false,
    validCall: false,
    exactMatch: false,
  };

  if (c.expect.type === "no_call") {
    base.validCall = !base.producedToolCall;
    base.exactMatch = base.validCall;
    return base;
  }

  if (c.expect.type === "avoid_repeat") {
    // The loop is broken unless the model re-emits the identical forbidden call
    // (same tool + deep-equal args). A corrected call, a different tool, or a
    // plain answer all count as recovery.
    const forbidden = c.expect;
    const message = (body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
      | Record<string, unknown>
      | undefined;
    const calls = Array.isArray(message?.tool_calls) ? (message!.tool_calls as Array<Record<string, unknown>>) : [];
    const stillLooping = calls.some((call) => {
      const fn = call.function as Record<string, unknown> | undefined;
      if (fn?.name !== forbidden.name) return false;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(typeof fn?.arguments === "string" ? fn.arguments : "{}");
      } catch {
        return false; // unparseable args ≠ the exact forbidden call
      }
      return deepEqual(parsed, forbidden.args);
    });
    base.validCall = !stillLooping;
    base.exactMatch = base.validCall;
    return base;
  }

  const expected = c.expect;
  const call = matchingCall(body, expected.name);
  if (!call) return base; // no call produced for a tool_call case → fail

  base.correctTool = call.name === expected.name;

  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(call.args || "{}");
    if (p !== null && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  base.validArgs = parsed !== null;

  const tool = c.tools.find((t) => t.function.name === expected.name);
  if (parsed && tool) {
    base.schemaValid = validateAgainstSchema(parsed, tool.function.parameters).length === 0;
  }

  if (parsed && expected.args) {
    base.argsMatch = Object.entries(expected.args).every(([k, v]) => deepEqual(parsed![k], v));
  } else if (!expected.args) {
    base.argsMatch = true; // no argument expectation to satisfy
  }

  base.validCall = base.producedToolCall && base.correctTool && base.validArgs && base.schemaValid;
  base.exactMatch = base.validCall && base.argsMatch;
  return base;
}

export interface Aggregate {
  total: number;
  validCallRate: number;
  exactMatchRate: number;
  toolCases: number;
  toolValidRate: number;
  toolExactRate: number;
  noCallCases: number;
  noCallCorrectRate: number;
  loopCases: number;
  loopBrokeRate: number;
}

export function aggregate(scores: CaseScore[]): Aggregate {
  const tool = scores.filter((s) => s.expectType === "tool_call");
  const noCall = scores.filter((s) => s.expectType === "no_call");
  const loop = scores.filter((s) => s.expectType === "avoid_repeat");
  const rate = (xs: CaseScore[], f: (s: CaseScore) => boolean) =>
    xs.length === 0 ? 0 : xs.filter(f).length / xs.length;
  return {
    total: scores.length,
    validCallRate: rate(scores, (s) => s.validCall),
    exactMatchRate: rate(scores, (s) => s.exactMatch),
    toolCases: tool.length,
    toolValidRate: rate(tool, (s) => s.validCall),
    toolExactRate: rate(tool, (s) => s.exactMatch),
    noCallCases: noCall.length,
    noCallCorrectRate: rate(noCall, (s) => s.validCall),
    loopCases: loop.length,
    loopBrokeRate: rate(loop, (s) => s.validCall),
  };
}
