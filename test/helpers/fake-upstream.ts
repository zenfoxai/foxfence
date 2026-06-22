/** A minimal OpenAI-compatible upstream for tests: serves /chat/completions
 * in both JSON and SSE modes and records every request it receives. */

export interface RecordedRequest {
  body: Record<string, unknown>;
  authorization: string | null;
}

/** Full control over a response: return a content string (wrapped in a
 * completion), a complete response body object, or a raw Response (e.g. a
 * custom SSE stream). */
export type UpstreamHandler = (
  body: Record<string, unknown>,
) => string | Record<string, unknown> | Response;

export interface FakeUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Content the fake model answers with (mode "fixed"). */
  reply: string;
  /** "echo" answers with the last message's content — lets tests observe
   * what the proxy actually sent upstream, round-tripped. */
  mode: "fixed" | "echo";
  /** When set, overrides reply/mode entirely. */
  handler: UpstreamHandler | null;
  /** When set, a stream:true request gets a native tool call over SSE. */
  sseToolCall: { name: string; args: Record<string, unknown> } | null;
  stop(): void;
}

export function startFakeUpstream(): FakeUpstream {
  const state: {
    requests: RecordedRequest[];
    reply: string;
    mode: "fixed" | "echo";
    handler: UpstreamHandler | null;
    sseToolCall: { name: string; args: Record<string, unknown> } | null;
  } = {
    requests: [],
    reply: "Hello from the fake model.",
    mode: "fixed",
    handler: null,
    sseToolCall: null,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "POST" || pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as Record<string, unknown>;
      state.requests.push({ body, authorization: req.headers.get("authorization") });

      const model = body.model as string;
      // Stream a native tool call as SSE (fragmented arguments), for testing
      // the incremental native tool-call path.
      if (body.stream === true && state.sseToolCall) {
        return streamToolCall(model, state.sseToolCall.name, state.sseToolCall.args);
      }
      if (state.handler) {
        const result = state.handler(body);
        if (result instanceof Response) return result;
        if (body.stream === true && typeof result === "string") {
          return streamResponse(model, result);
        }
        return Response.json(typeof result === "string" ? completion(model, result) : result);
      }
      let reply = state.reply;
      if (state.mode === "echo") {
        const messages = body.messages as Array<{ content?: unknown }>;
        const last = messages?.at(-1)?.content;
        if (typeof last === "string") reply = last;
      }
      if (body.stream === true) return streamResponse(model, reply);
      return Response.json(completion(model, reply));
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests: state.requests,
    get reply() {
      return state.reply;
    },
    set reply(value: string) {
      state.reply = value;
    },
    get mode() {
      return state.mode;
    },
    set mode(value: "fixed" | "echo") {
      state.mode = value;
    },
    get handler() {
      return state.handler;
    },
    set handler(value: UpstreamHandler | null) {
      state.handler = value;
    },
    get sseToolCall() {
      return state.sseToolCall;
    },
    set sseToolCall(value: { name: string; args: Record<string, unknown> } | null) {
      state.sseToolCall = value;
    },
    stop: () => server.stop(true),
  };
}

/** Streams a native tool call as SSE with the arguments fragmented across
 * chunks, the way a real server does. */
function streamToolCall(model: string, name: string, args: Record<string, unknown>): Response {
  const argStr = JSON.stringify(args);
  const mid = Math.ceil(argStr.length / 2);
  const events = [
    sse({ delta: { role: "assistant" }, finish_reason: null }, model),
    sse(
      { delta: { tool_calls: [{ index: 0, id: "call_up_1", type: "function", function: { name, arguments: "" } }] }, finish_reason: null },
      model,
    ),
    sse({ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(0, mid) } }] }, finish_reason: null }, model),
    sse({ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(mid) } }] }, finish_reason: null }, model),
    sse({ delta: {}, finish_reason: "tool_calls" }, model),
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const e of events) controller.enqueue(new TextEncoder().encode(e));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A completion body containing native tool_calls, for handler use. */
export function toolCallCompletion(
  model: string,
  name: string,
  args: Record<string, unknown> | string,
): Record<string, unknown> {
  return {
    id: "chatcmpl-fake-tc",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_up_1",
              type: "function",
              function: {
                name,
                arguments: typeof args === "string" ? args : JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

function completion(model: string, content: string) {
  return {
    id: "chatcmpl-fake-1",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
  };
}

function streamResponse(model: string, content: string): Response {
  // Split mid-word on purpose: clients must reassemble arbitrary chunking.
  const pieces = content.match(/.{1,3}/gs) ?? [];
  const chunks: string[] = [
    sse({ delta: { role: "assistant", content: "" }, finish_reason: null }, model),
    ...pieces.map((p) => sse({ delta: { content: p }, finish_reason: null }, model)),
    sse({ delta: {}, finish_reason: "stop" }, model),
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function sse(choice: Record<string, unknown>, model: string): string {
  const event = {
    id: "chatcmpl-fake-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model,
    choices: [{ index: 0, ...choice }],
  };
  return `data: ${JSON.stringify(event)}\n\n`;
}
