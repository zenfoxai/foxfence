import type { ToolDef, ToolShimStrategy } from "./strategy.ts";
import { getTools } from "./strategy.ts";
import { createJsonPromptedStrategy, type JsonPromptedOptions } from "./json-prompted.ts";

export type ConstrainedMode = "response_format" | "guided_json";

/**
 * The `constrained` strategy (§6.2 #2): the upstream constrains decoding to a
 * JSON Schema we supply, so weak models can't emit malformed tool calls. We
 * reuse the json-prompted wire protocol (`{"tool_call":{name,arguments}}` /
 * `{"final":...}`) and its tolerant decoder + repair loop, and additionally
 * pin the output shape with a per-tool union schema sent as the server's
 * constraint field. The injected system block still carries the tool
 * *semantics* (what each tool is for); the schema enforces the *format*.
 *
 * Compatibility: this targets local servers where weak models actually live —
 * vLLM (`guided_json`, or `response_format` json_schema; both enforce a
 * top-level `anyOf` via outlines/xgrammar) and llama.cpp (json_schema → GBNF).
 * We send `strict: false`: OpenAI's *strict* structured outputs require a root
 * `type: object` and reject a top-level `anyOf`, so strict mode is not used —
 * but you would rarely point this strategy at OpenAI anyway (it has native
 * tool calling). On any server that doesn't hard-enforce the schema, the
 * tolerant decoder + repair loop still recover the call, so it degrades to
 * json-prompted behaviour rather than breaking.
 */

function toolBranch(tool: ToolDef): Record<string, unknown> {
  const argsSchema = tool.function.parameters ?? { type: "object" };
  return {
    type: "object",
    properties: {
      tool_call: {
        type: "object",
        properties: {
          name: { const: tool.function.name },
          arguments: argsSchema,
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      },
    },
    required: ["tool_call"],
    additionalProperties: false,
  };
}

const FINAL_BRANCH = {
  type: "object",
  properties: { final: { type: "string" } },
  required: ["final"],
  additionalProperties: false,
};

/** Builds the union schema: one branch per allowed tool, plus a final-answer
 * branch unless a tool is forced via tool_choice. */
export function buildUnionSchema(body: Record<string, unknown>): Record<string, unknown> {
  const tools = getTools(body);
  const choice = body.tool_choice;

  // tool_choice "auto" (the default) and "none"/absent leave allowFinal true:
  // every tool branch plus the final-answer branch. "required" drops final; a
  // {function:{name}} object collapses to that one tool.
  let allowedTools = tools;
  let allowFinal = true;
  if (choice === "required") {
    allowFinal = false;
  } else if (choice !== null && typeof choice === "object") {
    const forced = ((choice as Record<string, unknown>).function as Record<string, unknown>)?.name;
    if (typeof forced === "string") {
      allowedTools = tools.filter((t) => t.function.name === forced);
      allowFinal = false;
    }
  }

  const branches: Record<string, unknown>[] = allowedTools.map(toolBranch);
  if (allowFinal) branches.push(FINAL_BRANCH);
  // No branches (e.g. tool_choice forced a tool that isn't declared) → stay
  // permissive rather than emit an unsatisfiable {anyOf: []} the server would
  // reject; the tolerant decoder + repair still handle the reply.
  if (branches.length === 0) return { type: "object" };
  // A single branch needs no anyOf wrapper.
  return branches.length === 1 ? branches[0]! : { anyOf: branches };
}

export function createConstrainedStrategy(
  mode: ConstrainedMode,
  opts: JsonPromptedOptions = {},
): ToolShimStrategy {
  const jp = createJsonPromptedStrategy(opts);
  return {
    name: "constrained",

    encode(body) {
      const base = jp.encode(body); // injects tool block, drops tools, stream:false
      const schema = buildUnionSchema(body);
      if (mode === "guided_json") {
        return { ...base, guided_json: schema };
      }
      return {
        ...base,
        response_format: {
          type: "json_schema",
          json_schema: { name: "foxfence_tool_call", schema, strict: false },
        },
      };
    },

    decode: jp.decode,
    repairTurn: jp.repairTurn,
  };
}
