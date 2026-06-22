/** Translation between the OpenAI **Responses API** (`/v1/responses`) and the
 * internal Chat Completions pivot (§3, §8). foxfence runs its whole pipeline
 * on the pivot, so /v1/responses is just an in/out adapter — every shim and
 * safety feature applies unchanged.
 *
 * Scope: non-streaming. Streaming uses a different event protocol
 * (response.output_text.delta, …) and is rejected with a clear error. */

type Json = Record<string, unknown>;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part !== null && typeof part === "object" && typeof (part as Json).text === "string") {
          return (part as Json).text as string;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Responses `input` (string or item array) + `instructions` → chat messages. */
export function toChatMessages(input: unknown, instructions: unknown): Json[] {
  const messages: Json[] = [];
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const raw of input) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Json;
    const type = item.type;
    if (type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: "function",
            function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
          },
        ],
      });
    } else if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
    } else {
      // a message item: { role, content } (content string or part array)
      const role = typeof item.role === "string" ? item.role : "user";
      messages.push({ role, content: extractText(item.content) });
    }
  }
  return messages;
}

/** Responses function tools (flat {type,name,...}) → chat tools (nested). */
export function toChatTools(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Json[] = [];
  for (const raw of tools) {
    if (raw === null || typeof raw !== "object") continue;
    const t = raw as Json;
    if (t.type !== "function") continue; // built-in tools (web_search, …) not shimmed
    const fn = (t.function ?? t) as Json; // accept flat or nested
    if (typeof fn.name !== "string") continue;
    out.push({ type: "function", function: { name: fn.name, description: fn.description, parameters: fn.parameters } });
  }
  return out.length > 0 ? out : undefined;
}

function toChatToolChoice(choice: unknown): unknown {
  if (choice === undefined) return undefined;
  if (choice !== null && typeof choice === "object") {
    const c = choice as Json;
    const name = typeof c.name === "string" ? c.name : ((c.function as Json | undefined)?.name as string | undefined);
    if (typeof name === "string") return { type: "function", function: { name } };
  }
  return choice; // "auto" | "none" | "required" pass through
}

const PASSTHROUGH = ["temperature", "top_p", "max_output_tokens", "max_tokens", "seed", "stop", "metadata"];

/** A /v1/responses request body → an internal chat completion request body. */
export function toChatRequest(body: Json): Json {
  const chat: Json = {
    model: body.model,
    messages: toChatMessages(body.input, body.instructions),
    stream: false,
  };
  const tools = toChatTools(body.tools);
  if (tools) chat.tools = tools;
  const tc = toChatToolChoice(body.tool_choice);
  if (tc !== undefined) chat.tool_choice = tc;
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  for (const k of PASSTHROUGH) if (k in body && !(k in chat)) chat[k] = body[k];
  return chat;
}

let counter = 0;
function id(prefix: string): string {
  return `${prefix}_fox_${(++counter).toString(36)}${crypto.randomUUID().slice(0, 8)}`;
}

/** A chat completion response body → a /v1/responses response object. */
export function toResponsesObject(chat: Json, exposedModel: string): Json {
  const choice = (chat.choices as Json[] | undefined)?.[0];
  const message = (choice?.message ?? {}) as Json;
  const output: Json[] = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({
      type: "message",
      id: id("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls as Json[]) {
      const fn = (call.function ?? {}) as Json;
      output.push({
        type: "function_call",
        id: id("fc"),
        call_id: call.id,
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        status: "completed",
      });
    }
  }

  const usage = chat.usage as Json | undefined;
  const finish = choice?.finish_reason;
  const result: Json = {
    id: id("resp"),
    object: "response",
    created_at: typeof chat.created === "number" ? chat.created : Math.floor(Date.now() / 1000),
    model: exposedModel,
    status: finish === "error" ? "failed" : finish === "content_filter" ? "completed" : "completed",
    output,
    output_text: output
      .filter((o) => o.type === "message")
      .map((o) => extractText(o.content))
      .join(""),
    usage: usage
      ? {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : undefined,
  };
  if (chat.foxfence !== undefined) result.foxfence = chat.foxfence;
  return result;
}
