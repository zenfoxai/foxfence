import type { DecodeResult, Msg, ToolDef, ToolShimStrategy } from "./strategy.ts";
import { getTools } from "./strategy.ts";
import {
  decodeNativeCalls,
  extractJsonObject,
  injectToolBlock,
  toToolCall,
  type JsonPromptedOptions,
} from "./json-prompted.ts";

/**
 * The `react` strategy (§6.2 #4) — a Thought/Action/Action Input format for
 * old or very small models that can't reliably hold a whole JSON object.
 * Last resort: opt-in via `shim: react` or a profile `pinStrategy: react`
 * (auto never selects it). Parsing is forgiving — the Action Input is read as
 * JSON when possible, and falls back to a single bare value for one-argument
 * tools (the common `Action Input: Paris` case).
 */

const MAX_DESCRIPTION_CHARS = 240;

function describeParams(parameters: Record<string, unknown> | undefined): string {
  const props = (parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(parameters?.required) ? (parameters!.required as string[]) : []);
  const names = Object.keys(props);
  if (names.length === 0) return "no arguments";
  return names
    .map((n) => {
      const t = typeof props[n]!.type === "string" ? (props[n]!.type as string) : "any";
      const en = Array.isArray(props[n]!.enum) ? ` one of ${JSON.stringify(props[n]!.enum)}` : "";
      return `${n} (${t}${required.has(n) ? ", required" : ""}${en})`;
    })
    .join(", ");
}

function describeTool(tool: ToolDef): string {
  let desc = (tool.function.description ?? "").replace(/\s+/g, " ").trim();
  if (desc.length > MAX_DESCRIPTION_CHARS) desc = desc.slice(0, MAX_DESCRIPTION_CHARS) + "…";
  return `- ${tool.function.name}: ${desc} Arguments: ${describeParams(tool.function.parameters)}`;
}

export function buildReactSystemBlock(body: Record<string, unknown>): string {
  const tools = getTools(body);
  const lines = [
    "You can use tools. To call a tool, reply in EXACTLY this format:",
    "",
    "Thought: <your reasoning>",
    "Action: <one tool name from the list below>",
    'Action Input: <the arguments as a JSON object, e.g. {"city": "Paris"}>',
    "",
    "When you can answer the user directly, reply:",
    "",
    "Thought: <your reasoning>",
    "Final Answer: <your answer>",
    "",
    "Use only one Action per reply. Never invent tool names.",
    "",
    "Available tools:",
    ...tools.map(describeTool),
  ];

  const choice = body.tool_choice;
  if (choice === "required") {
    lines.push("", "You MUST call a tool now (use Action / Action Input, not Final Answer).");
  } else if (choice !== null && typeof choice === "object") {
    const forced = ((choice as Record<string, unknown>).function as Record<string, unknown>)?.name;
    if (typeof forced === "string") {
      lines.push("", `You MUST call the tool "${forced}" now (use Action / Action Input).`);
    }
  }
  return lines.join("\n");
}

/** Renders prior assistant tool calls / tool results in ReAct style so a
 * multi-turn history reads consistently to the model. */
export function transformReactHistory(messages: Msg[]): Msg[] {
  const callNames = new Map<string, string>();
  const out: Msg[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const parts: string[] = [];
      if (typeof message.content === "string" && message.content) parts.push(`Thought: ${message.content}`);
      for (const call of message.tool_calls as Array<Record<string, unknown>>) {
        const fn = (call.function ?? {}) as Record<string, unknown>;
        if (typeof call.id === "string" && typeof fn.name === "string") callNames.set(call.id, fn.name);
        parts.push(`Action: ${fn.name}`, `Action Input: ${typeof fn.arguments === "string" ? fn.arguments : "{}"}`);
      }
      out.push({ role: "assistant", content: parts.join("\n") });
    } else if (message.role === "tool") {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      out.push({ role: "user", content: `Observation: ${content}` });
    } else {
      out.push(message);
    }
  }
  return out;
}

function coerceScalar(value: string, schema: Record<string, unknown> | undefined): unknown {
  const t = schema?.type;
  const trimmed = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (t === "number" || t === "integer") {
    const n = Number(trimmed);
    return Number.isNaN(n) ? trimmed : n;
  }
  if (t === "boolean") {
    if (/^true$/i.test(trimmed)) return true;
    if (/^false$/i.test(trimmed)) return false;
  }
  return trimmed;
}

/** Reads the Action Input text into an arguments object: JSON when possible,
 * otherwise a single bare value mapped onto a one-property tool. */
function parseActionInput(raw: string, tool: ToolDef | undefined): Record<string, unknown> | null {
  const obj = extractJsonObject(raw);
  if (obj !== null) return obj;
  const props = (tool?.function.parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const keys = Object.keys(props);
  if (keys.length === 1 && raw.trim().length > 0) {
    return { [keys[0]!]: coerceScalar(raw, props[keys[0]!]) };
  }
  return null;
}

export function parseReactOutput(content: string, tools: ToolDef[], toolDemanded: boolean): DecodeResult {
  const actionMatch = content.match(/Action\s*:\s*([^\n]+)/i);
  const inputMatch = content.match(/Action\s+Input\s*:\s*([\s\S]*?)(?:\n\s*(?:Observation|Thought)\s*:|$)/i);
  const finalMatch = content.match(/Final\s+Answer\s*:\s*([\s\S]*)$/i);

  // An Action with its Input is a tool call (the model wants to act).
  if (actionMatch && inputMatch) {
    const name = actionMatch[1]!.trim().replace(/^["'`]|["'`:]+$/g, "").trim();
    const tool = tools.find((t) => t.function.name === name);
    const args = parseActionInput(inputMatch[1]!, tool);
    if (args === null) {
      return {
        ok: false,
        error: `could not parse Action Input for "${name}"`,
        repairHint: 'Put the Action Input on one line as a JSON object, e.g. Action Input: {"city": "Paris"}.',
      };
    }
    const result = toToolCall(name, args, tools);
    if ("error" in result) return { ok: false, error: result.error, repairHint: result.error };
    return { ok: true, message: { role: "assistant", content: null, tool_calls: [result.call] }, finishReason: "tool_calls" };
  }

  if (finalMatch) {
    if (toolDemanded) {
      return {
        ok: false,
        error: "a tool call was required but the model gave a Final Answer",
        repairHint: "You must call a tool. Use Action / Action Input, not Final Answer.",
      };
    }
    return { ok: true, message: { role: "assistant", content: finalMatch[1]!.trim() }, finishReason: "stop" };
  }

  if (toolDemanded) {
    return {
      ok: false,
      error: "no Action found but a tool call was required",
      repairHint: 'Reply with: Action: <tool>\\nAction Input: {...}',
    };
  }
  // No ReAct markers and no tool needed: take the text as the answer, dropping
  // a leading "Thought:" label if present.
  const answer = content.replace(/^\s*Thought\s*:\s*/i, "").trim();
  return { ok: true, message: { role: "assistant", content: answer }, finishReason: "stop" };
}

export function createReactStrategy(opts: JsonPromptedOptions = {}): ToolShimStrategy {
  return {
    name: "react",

    encode(body) {
      const systemBlock = buildReactSystemBlock(body);
      const original = Array.isArray(body.messages) ? (body.messages as Msg[]) : [];
      const messages = injectToolBlock(transformReactHistory(original), systemBlock, opts.noSystemRole ?? false);
      const { tools: _t, tool_choice: _c, parallel_tool_calls: _p, ...rest } = body;
      return { ...rest, messages, stream: false };
    },

    decode(upstreamBody, original): DecodeResult {
      const tools = getTools(original);
      const message = (upstreamBody.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
        | Record<string, unknown>
        | undefined;

      // A model that emits native tool_calls despite the shim is fine.
      if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return decodeNativeCalls(message, tools);
      }

      const content = typeof message?.content === "string" ? message.content : "";
      if (content.trim().length === 0) {
        return { ok: false, error: "empty reply", repairHint: "Your reply was empty." };
      }
      const choice = original.tool_choice;
      const toolDemanded = choice === "required" || (choice !== null && typeof choice === "object");
      return parseReactOutput(content, tools, toolDemanded);
    },

    repairTurn(upstreamBody, repairHint) {
      const message = (upstreamBody.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
        | Record<string, unknown>
        | undefined;
      const raw = typeof message?.content === "string" ? message.content : JSON.stringify(message ?? {});
      return [
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `That was not in the right format: ${repairHint}\nReply again using Thought / Action / Action Input or Thought / Final Answer.`,
        },
      ];
    },
  };
}
