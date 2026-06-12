/** §11.1 golden suite: the official OpenAI SDK must work unmodified against
 * foxfence, streaming included. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

const AGENT_KEY = "test-agent-key";
const UPSTREAM_KEY = "upstream-secret-key";

let upstream: FakeUpstream;
let foxfence: ReturnType<typeof createServer>;
let client: OpenAI;

beforeAll(() => {
  upstream = startFakeUpstream();
  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    api_keys: [AGENT_KEY],
    upstreams: [{ name: "fake", base_url: upstream.baseUrl, api_key: UPSTREAM_KEY }],
    models: [{ expose: "qwen-tools", upstream: "fake", model: "qwen2.5:7b-instruct" }],
  });
  foxfence = createServer(config);
  client = new OpenAI({
    baseURL: `http://127.0.0.1:${foxfence.port}/v1`,
    apiKey: AGENT_KEY,
  });
});

afterAll(() => {
  foxfence.stop(true);
  upstream.stop();
});

describe("non-streaming chat completion", () => {
  test("round-trips through the proxy with the SDK", async () => {
    const res = await client.chat.completions.create({
      model: "qwen-tools",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.choices[0]?.message.content).toBe("Hello from the fake model.");
    expect(res.usage?.total_tokens).toBe(12);
  });

  test("rewrites the model name and swaps auth for the upstream's key", async () => {
    const seen = upstream.requests.at(-1)!;
    expect(seen.body.model).toBe("qwen2.5:7b-instruct");
    expect(seen.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(seen.authorization).not.toContain(AGENT_KEY);
  });

  test("forwards non-model fields untouched", async () => {
    await client.chat.completions.create({
      model: "qwen-tools",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
      max_tokens: 64,
      // @ts-expect-error -- unknown fields must pass through too
      vendor_specific_knob: { nested: true },
    });
    const seen = upstream.requests.at(-1)!;
    expect(seen.body.temperature).toBe(0.3);
    expect(seen.body.max_tokens).toBe(64);
    expect(seen.body.vendor_specific_knob).toEqual({ nested: true });
  });
});

describe("streaming chat completion", () => {
  test("relays SSE chunks the SDK can reassemble", async () => {
    upstream.reply = "Streaming answer with several chunks.";
    const stream = await client.chat.completions.create({
      model: "qwen-tools",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    let assembled = "";
    let sawStop = false;
    for await (const chunk of stream) {
      assembled += chunk.choices[0]?.delta.content ?? "";
      if (chunk.choices[0]?.finish_reason === "stop") sawStop = true;
    }
    expect(assembled).toBe("Streaming answer with several chunks.");
    expect(sawStop).toBe(true);
  });
});

describe("/v1/models", () => {
  test("lists exposed names, not upstream model ids", async () => {
    const models = await client.models.list();
    const ids = models.data.map((m) => m.id);
    expect(ids).toEqual(["qwen-tools"]);
  });
});

describe("errors in OpenAI format", () => {
  // The SDK's lazy APIPromise confuses bun:test's `.rejects` matcher, so we
  // capture the rejection explicitly instead.
  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
      return null;
    } catch (e) {
      return e;
    }
  }

  test("unknown model → 404 the SDK maps to NotFoundError", async () => {
    const err = await rejectionOf(
      client.chat.completions.create({
        model: "no-such-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(err).toBeInstanceOf(OpenAI.NotFoundError);
  });

  test("bad API key → 401 the SDK maps to AuthenticationError", async () => {
    const badClient = new OpenAI({
      baseURL: `http://127.0.0.1:${foxfence.port}/v1`,
      apiKey: "wrong-key",
    });
    const err = await rejectionOf(
      badClient.chat.completions.create({
        model: "qwen-tools",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(err).toBeInstanceOf(OpenAI.AuthenticationError);
  });

  test("malformed JSON body → 400 with OpenAI error shape", async () => {
    const res = await fetch(`http://127.0.0.1:${foxfence.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_KEY}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("healthz is reachable without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${foxfence.port}/healthz`);
    expect(res.status).toBe(200);
  });
});
