import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema } from "../src/shim/args-validate.ts";

/** A BFCL-style evaluation case (§11.2). The on-disk JSON shape is identical
 * to what the corpus generator produces, so generated and hand-written cases
 * are interchangeable. */
export interface RawCase {
  id: string;
  category: string;
  description: string;
  /** The current user turn. Optional when `history` is present (a loop case
   * resumes after a tool result, with no new user message). */
  user?: string;
  /** Prior conversation turns in OpenAI message shape — used by multi-turn
   * cases (loop recovery, state drift). Sent verbatim before `user`. */
  history?: Array<Record<string, unknown>>;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  expect:
    | { type: "tool_call"; name: string; args?: Record<string, unknown> }
    | { type: "no_call" }
    // Loop recovery: the response must NOT be the identical repeated call —
    // a corrected call, a different tool, or a final answer all pass.
    | { type: "avoid_repeat"; name: string; args: Record<string, unknown> };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface EvalCase {
  id: string;
  category: string;
  description: string;
  messages: Array<Record<string, unknown>>;
  tools: ToolDef[];
  expect: RawCase["expect"];
}

export function normalize(raw: RawCase): EvalCase {
  const messages: Array<Record<string, unknown>> = [...(raw.history ?? [])];
  if (raw.user) messages.push({ role: "user", content: raw.user });
  return {
    id: raw.id,
    category: raw.category,
    description: raw.description,
    messages,
    tools: raw.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    expect: raw.expect,
  };
}

/** Structural + self-consistency validation: the expected call must name a
 * declared tool and its args must satisfy that tool's JSON Schema. This is the
 * hard gate every case (seed or generated) passes through, so the eval can
 * never silently score against a malformed case. */
export function validateCase(raw: RawCase): string[] {
  const errors: string[] = [];
  if (!raw.id || (!raw.user && !raw.history) || !Array.isArray(raw.tools) || raw.tools.length === 0) {
    errors.push("missing id/(user|history)/tools");
    return errors;
  }
  const byName = new Map(raw.tools.map((t) => [t.name, t]));
  for (const t of raw.tools) {
    if (!t.name || !t.parameters || typeof t.parameters !== "object") {
      errors.push(`tool "${t.name}" has no parameters schema`);
    }
  }
  if (raw.expect.type === "tool_call" || raw.expect.type === "avoid_repeat") {
    const tool = byName.get(raw.expect.name);
    if (!tool) {
      errors.push(`expected tool "${raw.expect.name}" is not among the declared tools`);
    } else if (raw.expect.args) {
      // expect.args is a PARTIAL matcher: each named key must exist in the
      // tool's properties and satisfy that property's schema, but it need not
      // pin every required argument (e.g. a "select the right tool" case).
      const props = (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [key, value] of Object.entries(raw.expect.args)) {
        if (!props[key]) {
          errors.push(`expect.args has unknown property "${key}"`);
        } else {
          errors.push(...validateAgainstSchema(value, props[key], `expect.args.${key}`));
        }
      }
    }
  } else if (raw.expect.type !== "no_call") {
    errors.push(`unknown expect.type`);
  }
  return errors;
}

export interface LoadResult {
  cases: EvalCase[];
  skipped: Array<{ id: string; errors: string[] }>;
}

/** Loads and validates every *.json case file in eval/cases. Each file is
 * either a single case object or an array of cases. Invalid cases are skipped
 * (not silently dropped — they are reported). */
export function loadCorpus(dir?: string): LoadResult {
  const casesDir = dir ?? join(dirname(fileURLToPath(import.meta.url)), "cases");
  const cases: EvalCase[] = [];
  const skipped: LoadResult["skipped"] = [];
  const seen = new Set<string>();

  for (const file of readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(casesDir, file), "utf8"));
    const raws: RawCase[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const raw of raws) {
      const errors = validateCase(raw);
      if (seen.has(raw.id)) errors.push(`duplicate id "${raw.id}"`);
      if (errors.length > 0) {
        skipped.push({ id: raw.id ?? `(${file})`, errors });
        continue;
      }
      seen.add(raw.id);
      cases.push(normalize(raw));
    }
  }
  return { cases, skipped };
}
