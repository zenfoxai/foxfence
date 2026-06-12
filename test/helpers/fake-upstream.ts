/** A minimal OpenAI-compatible upstream for tests: serves /chat/completions
 * in both JSON and SSE modes and records every request it receives. */

export interface RecordedRequest {
  body: Record<string, unknown>;
  authorization: string | null;
}

export interface FakeUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Content the fake model answers with. */
  reply: string;
  stop(): void;
}

export function startFakeUpstream(): FakeUpstream {
  const state: { requests: RecordedRequest[]; reply: string } = {
    requests: [],
    reply: "Hello from the fake model.",
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
      if (body.stream === true) return streamResponse(model, state.reply);
      return Response.json(completion(model, state.reply));
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
    stop: () => server.stop(true),
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
