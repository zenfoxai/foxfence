import type { ModelRoute, Upstream } from "./config/schema.ts";
import type { Detector, Phase, RequestContext, Verdict } from "./security/detector.ts";
import { createContext } from "./security/detector.ts";
import { AuditLog, type AuditVerdict } from "./audit.ts";
import type { Metrics } from "./metrics.ts";
import { errors } from "./pivot/errors.ts";
import { callUpstream, relayResponse, UpstreamError } from "./upstream/client.ts";
import { CapabilityStore, chooseStrategy, type StrategyChoice } from "./shim/probe.ts";
import { runToolShim } from "./shim/repair.ts";
import { StreamSanitizer } from "./shim/stream-sanitize.ts";
import { detectToolCallLoop, loopBreakerNudge, loopBreakResponse } from "./loop.ts";

export interface PipelineOptions {
  detectors: Detector[];
  onDetectorError: "block" | "pass";
  audit: AuditLog | null;
  auditIncludeContent: boolean;
  capabilities: CapabilityStore;
  metrics: Metrics | null;
}

/** A mutable reference to one text segment inside the request/response. */
interface Segment {
  holder: Record<string, unknown>;
  key: string;
  location: string;
  role?: string;
}

function segmentText(s: Segment): string {
  return s.holder[s.key] as string;
}

/** Collects every string the detectors should see in a chat request:
 * message contents (plain or multipart text). */
function requestSegments(body: Record<string, unknown>): Segment[] {
  const segments: Segment[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach((message, i) => {
    if (message === null || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : undefined;
    if (typeof m.content === "string") {
      segments.push({ holder: m, key: "content", location: `messages[${i}].content`, role });
    } else if (Array.isArray(m.content)) {
      m.content.forEach((part, j) => {
        if (part !== null && typeof part === "object" && typeof part.text === "string") {
          segments.push({
            holder: part as Record<string, unknown>,
            key: "text",
            location: `messages[${i}].content[${j}].text`,
            role,
          });
        }
      });
    }
  });
  return segments;
}

/** Collects detector-visible strings in a chat response: assistant content
 * and tool-call arguments (placeholders can be echoed into either). */
function responseSegments(body: Record<string, unknown>): Segment[] {
  const segments: Segment[] = [];
  const choices = Array.isArray(body.choices) ? body.choices : [];
  choices.forEach((choice, i) => {
    const message = (choice as Record<string, unknown>)?.message;
    if (message === null || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    if (typeof m.content === "string") {
      segments.push({ holder: m, key: "content", location: `choices[${i}].message.content`, role: "assistant" });
    }
    if (Array.isArray(m.tool_calls)) {
      m.tool_calls.forEach((call, j) => {
        const fn = (call as Record<string, unknown>)?.function;
        if (fn !== null && typeof fn === "object" && typeof (fn as Record<string, unknown>).arguments === "string") {
          segments.push({
            holder: fn as Record<string, unknown>,
            key: "arguments",
            location: `choices[${i}].message.tool_calls[${j}].function.arguments`,
          });
        }
      });
    }
  });
  return segments;
}

interface ScanOutcome {
  blocked?: { detector: string; reason: string; userMessage?: string };
  verdicts: AuditVerdict[];
  masked: number;
}

/** Runs every detector over every segment for one phase, applying masks in
 * place. Detector failure is handled per `onDetectorError` (§2 principle 6:
 * fail-closed must be explicit, never implicit). */
async function scan(
  segments: Segment[],
  phase: Phase,
  detectors: Detector[],
  ctx: RequestContext,
  onDetectorError: "block" | "pass",
): Promise<ScanOutcome> {
  const outcome: ScanOutcome = { verdicts: [], masked: 0 };
  for (const detector of detectors) {
    if (!detector.phases.includes(phase) || !detector.inspect) continue;
    for (const segment of segments) {
      let verdict: Verdict;
      try {
        verdict = await detector.inspect(
          { text: segmentText(segment), location: segment.location, role: segment.role },
          phase,
          ctx,
        );
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        outcome.verdicts.push({
          detector: detector.name,
          action: `error:${onDetectorError}`,
          location: segment.location,
          detail,
        });
        if (onDetectorError === "block") {
          outcome.blocked = {
            detector: detector.name,
            reason: `detector "${detector.name}" failed (${detail}); fail-closed policy`,
          };
          return outcome;
        }
        continue;
      }

      if (verdict.action === "pass") continue;
      if (verdict.action === "flag") {
        outcome.verdicts.push({
          detector: detector.name,
          action: "flag",
          location: segment.location,
          detail: verdict.reason,
        });
      } else if (verdict.action === "block") {
        outcome.verdicts.push({
          detector: detector.name,
          action: "block",
          location: segment.location,
          detail: verdict.reason,
        });
        outcome.blocked = {
          detector: detector.name,
          reason: verdict.reason,
          userMessage: verdict.userMessage,
        };
        return outcome;
      } else {
        let text = segmentText(segment);
        for (const r of verdict.replacements) {
          text = text.replaceAll(r.original, r.placeholder);
          if (r.restore) ctx.maskTable.set(r.placeholder, r.original);
          outcome.masked++;
        }
        segment.holder[segment.key] = text;
        outcome.verdicts.push({
          detector: detector.name,
          action: "mask",
          location: segment.location,
          detail: verdict.replacements.map((r) => r.kind).join(", "),
        });
      }
    }
  }
  return outcome;
}

/** Restores mask & restore placeholders in response segments. */
function restore(segments: Segment[], ctx: RequestContext): number {
  let restored = 0;
  if (ctx.maskTable.size === 0) return 0;
  for (const segment of segments) {
    let text = segmentText(segment);
    for (const [placeholder, original] of ctx.maskTable) {
      if (text.includes(placeholder)) {
        text = text.replaceAll(placeholder, original);
        restored++;
      }
    }
    segment.holder[segment.key] = text;
  }
  return restored;
}

interface ToolPolicyOutcome {
  verdicts: AuditVerdict[];
  blocked: Array<{ tool: string; reason: string }>;
  flagged: Array<{ tool: string; reason: string }>;
  blockedAny: boolean;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Tool-call policy enforcement (§5.3), run on the final reconstructed tool
 * calls so it covers shimmed models too. Mutates `body` in place:
 *
 * - a blocked call is REMOVED from the assistant turn and its reason appended
 *   to the message content ("blocked by policy: …"), so the agent gets in-band
 *   feedback and can recover (a single OpenAI completion is always
 *   role:assistant — the spec's literal role:tool reply is not expressible in
 *   one turn, so the assistant-content note is the faithful equivalent);
 * - allowed calls in the same turn are preserved (partial execution caveat is
 *   documented in the README);
 * - if no calls remain, finish_reason becomes "stop".
 */
async function applyToolPolicy(
  body: Record<string, unknown>,
  detectors: Detector[],
  ctx: RequestContext,
  onDetectorError: "block" | "pass",
): Promise<ToolPolicyOutcome> {
  const out: ToolPolicyOutcome = { verdicts: [], blocked: [], flagged: [], blockedAny: false };
  const policyDetectors = detectors.filter(
    (d) => d.phases.includes("tool_call") && d.inspectToolCall,
  );
  if (policyDetectors.length === 0) return out;

  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (let ci = 0; ci < choices.length; ci++) {
    const message = (choices[ci] as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;
    if (!message || !Array.isArray(message.tool_calls)) continue;

    const calls = message.tool_calls as Array<Record<string, unknown>>;
    const kept: Array<Record<string, unknown>> = [];
    const notices: string[] = [];

    for (let ti = 0; ti < calls.length; ti++) {
      const call = calls[ti]!;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : "";
      const rawArguments = typeof fn.arguments === "string" ? fn.arguments : "";
      const input = {
        name,
        arguments: parseArgs(rawArguments),
        rawArguments,
        index: ti,
        location: `choices[${ci}].message.tool_calls[${ti}]`,
      };

      let blocked = false;
      for (const detector of policyDetectors) {
        let verdict: Verdict;
        try {
          verdict = await detector.inspectToolCall!(input, ctx);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          out.verdicts.push({
            detector: detector.name,
            action: `error:${onDetectorError}`,
            location: input.location,
            detail,
          });
          if (onDetectorError === "block") {
            verdict = { action: "block", reason: `detector "${detector.name}" failed (${detail}); fail-closed policy` };
          } else {
            continue;
          }
        }

        if (verdict.action === "block") {
          out.verdicts.push({ detector: detector.name, action: "block", location: input.location, detail: verdict.reason });
          out.blocked.push({ tool: name, reason: verdict.reason });
          notices.push(verdict.userMessage ?? `blocked by policy: ${verdict.reason}`);
          out.blockedAny = true;
          blocked = true;
          break; // first block wins; drop this call
        }
        if (verdict.action === "flag") {
          out.verdicts.push({ detector: detector.name, action: "flag", location: input.location, detail: verdict.reason });
          out.flagged.push({ tool: name, reason: verdict.reason });
        }
      }
      if (!blocked) kept.push(call);
    }

    if (notices.length === 0) continue;
    if (kept.length === 0) {
      // Whole turn refused: drop tool_calls and put the policy reason in
      // content so the agent gets in-band, recoverable feedback.
      delete message.tool_calls;
      const existing =
        typeof message.content === "string" && message.content ? `${message.content}\n` : "";
      message.content = existing + notices.join("\n");
      (choices[ci] as Record<string, unknown>).finish_reason = "stop";
    } else {
      // Some calls survive. Keep them and leave content untouched — OpenAI
      // clients may reject content set alongside tool_calls, and the block is
      // already surfaced via foxfence.tool_policy + the X-Foxfence-Blocked
      // header. finish_reason stays "tool_calls" since calls remain.
      message.tool_calls = kept;
      (choices[ci] as Record<string, unknown>).finish_reason = "tool_calls";
    }
  }
  return out;
}

/** Safety blocks are a normal completion with finish_reason "content_filter"
 * and an X-Foxfence-Blocked header (§8) — agents recover gracefully from a
 * refusal, not from an HTTP 4xx. */
function blockedResponse(
  ctx: RequestContext,
  blocked: { detector: string; reason: string; userMessage?: string },
): Response {
  return Response.json(
    {
      id: `chatcmpl-fox-${ctx.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: ctx.exposedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: blocked.userMessage ?? `Blocked by foxfence policy: ${blocked.reason}`,
          },
          finish_reason: "content_filter",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      foxfence: { blocked: true, detector: blocked.detector, reason: blocked.reason },
    },
    { headers: { "x-foxfence-blocked": "true" } },
  );
}

/** Replays a fully-parsed completion as conformant SSE chunks (§6.5, phase 3
 * buffered version: correct first, incremental streaming later). The client
 * never sees the shim's intermediate format. */
function completionToSSE(body: Record<string, unknown>, headers: Headers): Response {
  const base = {
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
  };
  const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  const events: Array<Record<string, unknown>> = [];

  const first: Record<string, unknown> = { role: "assistant" };
  events.push({ ...base, choices: [{ index: 0, delta: first, finish_reason: null }] });
  if (typeof message.content === "string" && message.content.length > 0) {
    events.push({
      ...base,
      choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    events.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: (message.tool_calls as Array<Record<string, unknown>>).map((call, i) => ({
              index: i,
              id: call.id,
              type: call.type,
              function: call.function,
            })),
          },
          finish_reason: null,
        },
      ],
    });
  }
  events.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    ...(body.usage !== undefined ? { usage: body.usage } : {}),
    ...(body.foxfence !== undefined ? { foxfence: body.foxfence } : {}),
  });

  const payload =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  return new Response(payload, { status: 200, headers });
}

interface StreamFinalize {
  ctx: RequestContext;
  route: ModelRoute;
  opts: PipelineOptions;
  priorVerdicts: AuditVerdict[];
  maskedSoFar: number;
  shimInfo?: Record<string, unknown>;
  loopInfo?: Record<string, unknown>;
  onComplete: (info: { verdicts: AuditVerdict[]; masked: number; restored: number; usage?: unknown }) => void;
}

/**
 * Incremental streaming (§6.5): parse the upstream SSE, stream content deltas
 * to the client through the StreamSanitizer (mask-restore + secret redaction,
 * never leaking a partial secret across chunks), and buffer tool-call deltas
 * to validate, restore, and run through tool-policy before emitting them. Used
 * for native streaming and tool-free streaming; the shimmed protocols stay
 * buffered (they need the whole reply to parse).
 *
 * Streaming tradeoffs vs the buffered path (documented in the README): a
 * response-phase secret *block* degrades to *redact* (you can't un-send
 * streamed bytes), and native tool-call arguments are not schema-repaired
 * (repair needs a fresh upstream turn) — they are still secret-scanned,
 * restored, and policy-checked.
 */
function streamUpstream(upstreamResponse: Response, fin: StreamFinalize): Response {
  const { ctx, route, opts } = fin;
  const redactNew = opts.detectors.some((d) => d.name === "secrets");
  const sanitizer = new StreamSanitizer(ctx.maskTable, redactNew);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const meta = { id: `chatcmpl-fox-${ctx.id}`, created: Math.floor(Date.now() / 1000) };
      let started = false;
      let finishReason: string | null = null;
      let usage: unknown;
      const tools = new Map<number, { id?: string; type?: string; name?: string; args: string }>();
      let syntheticIdx = -1; // allocates indices when the upstream omits them
      let closed = false; // controller closed (e.g. client disconnected)

      const emit = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: meta.id,
                object: "chat.completion.chunk",
                created: meta.created,
                model: route.expose,
                choices: [{ index: 0, delta, finish_reason: finish }],
                ...extra,
              })}\n\n`,
            ),
          );
        } catch {
          closed = true; // the client went away
        }
      };
      const startOnce = () => {
        if (!started) {
          started = true;
          emit({ role: "assistant" });
        }
      };

      const onEvent = (jsonStr: string) => {
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          return;
        }
        if (typeof chunk.id === "string") meta.id = chunk.id;
        if (typeof chunk.created === "number") meta.created = chunk.created;
        if (chunk.usage) usage = chunk.usage;
        const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
        if (!choice) return;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          startOnce();
          const out = sanitizer.push(delta.content);
          if (out) emit({ content: out });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const fn = tc.function as Record<string, unknown> | undefined;
            // Compliant servers always send `index`. A non-compliant upstream
            // may omit it; use the start-of-call markers (a new id/name) to
            // allocate a fresh slot so two index-less calls don't merge.
            let idx: number;
            if (typeof tc.index === "number") {
              idx = tc.index;
            } else if (typeof tc.id === "string" || typeof fn?.name === "string") {
              idx = ++syntheticIdx;
            } else {
              idx = syntheticIdx < 0 ? (syntheticIdx = 0) : syntheticIdx;
            }
            const cur = tools.get(idx) ?? { args: "" };
            if (typeof tc.id === "string") cur.id = tc.id;
            if (typeof tc.type === "string") cur.type = tc.type;
            if (typeof fn?.name === "string") cur.name = fn.name;
            if (typeof fn?.arguments === "string") cur.args += fn.arguments;
            tools.set(idx, cur);
          }
        }
      };

      const verdicts = [...fin.priorVerdicts];
      let masked = fin.maskedSoFar;
      let restored = 0;
      let streamError = false;
      let reader: ReturnType<NonNullable<typeof upstreamResponse.body>["getReader"]> | undefined;

      try {
        const r = upstreamResponse.body!.getReader();
        reader = r;
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const event = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            for (const line of event.split("\n")) {
              const t = line.trim();
              if (!t.startsWith("data:")) continue;
              const data = t.slice(5).trim();
              if (data && data !== "[DONE]") onEvent(data);
            }
          }
        }
      } catch {
        // upstream stream interrupted — surface it rather than passing off a
        // truncated reply as complete.
        streamError = true;
      } finally {
        try {
          await reader?.cancel();
        } catch {
          /* reader already done */
        }
      }

      try {
        startOnce();
        const tail = sanitizer.flush();
        if (tail) emit({ content: tail });

        if (tools.size > 0) {
          const tool_calls = [...tools.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, c]) => ({
              id: c.id ?? `call_fox_${crypto.randomUUID().slice(0, 8)}`,
              type: c.type ?? "function",
              function: { name: c.name ?? "", arguments: c.args || "{}" },
            }));
          const synthetic: Record<string, unknown> = {
            choices: [{ message: { role: "assistant", content: null, tool_calls }, finish_reason: "tool_calls" }],
          };
          const segs = responseSegments(synthetic);
          const out = await scan(segs, "response", opts.detectors, ctx, opts.onDetectorError);
          verdicts.push(...out.verdicts);
          masked += out.masked;
          restored += restore(segs, ctx);
          const policy = await applyToolPolicy(synthetic, opts.detectors, ctx, opts.onDetectorError);
          verdicts.push(...policy.verdicts);

          const choice0 = (synthetic.choices as Array<Record<string, unknown>>)[0]!;
          const msg = choice0.message as Record<string, unknown>;
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            emit({
              tool_calls: (msg.tool_calls as Array<Record<string, unknown>>).map((c, i) => ({
                index: i,
                id: c.id,
                type: c.type,
                function: c.function,
              })),
            });
            finishReason = "tool_calls";
          } else {
            if (typeof msg.content === "string" && msg.content) emit({ content: msg.content });
            finishReason = (choice0.finish_reason as string | undefined) ?? "stop";
          }
        }

        const foxfence =
          verdicts.length > 0 || fin.shimInfo || fin.loopInfo || streamError
            ? {
                ...(verdicts.length > 0 ? { verdicts, masked, restored } : {}),
                ...(fin.shimInfo ? { shim: fin.shimInfo } : {}),
                ...(fin.loopInfo ? { loop: fin.loopInfo } : {}),
                ...(streamError ? { stream_error: true } : {}),
              }
            : undefined;
        emit({}, finishReason ?? "stop", {
          ...(usage ? { usage } : {}),
          ...(foxfence ? { foxfence } : {}),
        });
      } catch {
        /* finalization failed (e.g. client gone) — still close cleanly below */
      } finally {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            /* already closed */
          }
        }
        fin.onComplete({ verdicts, masked, restored, usage });
      }
    },
  });

  const headers = new Headers({ "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (fin.shimInfo && typeof fin.shimInfo.repairs === "number" && (fin.shimInfo.repairs as number) > 0) {
    headers.set("x-foxfence-repairs", String(fin.shimInfo.repairs));
  }
  if (fin.loopInfo) headers.set("x-foxfence-loop", "nudge");
  return new Response(stream, { status: 200, headers });
}

export async function handleChatCompletion(
  body: Record<string, unknown>,
  route: ModelRoute,
  upstream: Upstream,
  opts: PipelineOptions,
): Promise<Response> {
  const started = Date.now();
  const ctx = createContext(route.expose, body.stream === true);
  const verdicts: AuditVerdict[] = [];
  let masked = 0;
  let restored = 0;
  let shimInfo: Record<string, unknown> | undefined;
  let loopInfo: Record<string, unknown> | undefined;

  const audit = (
    status: number,
    blocked: boolean,
    extra: Record<string, unknown> = {},
  ) => {
    const record = {
      ts: new Date().toISOString(),
      id: ctx.id,
      model: route.expose,
      upstream: upstream.name,
      upstream_model: route.model,
      stream: ctx.stream,
      status,
      blocked,
      verdicts,
      masked,
      restored,
      latency_ms: { total: Date.now() - started, upstream: 0 },
      ...(shimInfo ? { shim: shimInfo } : {}),
      ...(opts.auditIncludeContent ? { content: { request: body.messages, response: null } } : {}),
      ...extra,
    };
    opts.audit?.write(record);
    opts.metrics?.record(record);
  };

  // ── Pipeline IN ────────────────────────────────────────────────
  const inbound = await scan(
    requestSegments(body),
    "request",
    opts.detectors,
    ctx,
    opts.onDetectorError,
  );
  verdicts.push(...inbound.verdicts);
  masked += inbound.masked;
  if (inbound.blocked) {
    audit(200, true);
    return blockedResponse(ctx, inbound.blocked);
  }

  // ── Loop-breaker (failure mode: infinite retry loops) ──────────
  // Stateless: detection reads only the inbound history. "break" short-circuits
  // with a deterministic completion (no upstream call); "nudge" appends a
  // corrective system message so the model gets a chance to adapt itself.
  const lb = route.loop_breaker as
    | { enabled?: boolean; threshold?: number; action?: "nudge" | "break" }
    | undefined;
  if (lb?.enabled !== false) {
    const detection = detectToolCallLoop(body.messages, lb?.threshold ?? 3);
    if (detection) {
      const action = lb?.action ?? "nudge";
      loopInfo = { tool: detection.tool, count: detection.count, action };
      if (action === "break") {
        const broken = loopBreakResponse(route.expose, detection);
        audit(200, false, { loop: loopInfo });
        const headers = new Headers({ "x-foxfence-loop": "break" });
        return ctx.stream ? completionToSSE(broken, headers) : Response.json(broken, { status: 200, headers });
      }
      // nudge: mutate the outbound request — every downstream path (native,
      // shimmed, plain) reads this same body, so the model always sees it.
      (body.messages as unknown[]).push(loopBreakerNudge(detection));
    }
  }

  // ── Strategy selection (§6.1) ──────────────────────────────────
  const wantsTools =
    Array.isArray(body.tools) && (body.tools as unknown[]).length > 0 && body.tool_choice !== "none";
  let choice: StrategyChoice | null = null;
  if (wantsTools) {
    try {
      choice = await chooseStrategy(route, upstream, opts.capabilities);
    } catch (e) {
      if (e instanceof UpstreamError) {
        audit(502, false);
        return errors.upstreamUnreachable(e.upstreamName, e.detail);
      }
      throw e;
    }
    shimInfo = { strategy: choice.strategy.name, source: choice.capabilities?.source };
  }

  // ── Upstream ───────────────────────────────────────────────────
  // Native and tool-free streams go out token-by-token through the sanitizer
  // (mask-restore + secret redaction, tool calls validated/policy-checked).
  // The shimmed strategies (json-prompted/constrained/react) still buffer:
  // they need the whole reply to parse, then re-stream via completionToSSE.
  const streamIncremental = ctx.stream && (choice === null || choice.strategy.name === "native");
  const upstreamStarted = Date.now();
  let responseBody: Record<string, unknown>;

  if (streamIncremental) {
    let upstreamResponse: Response;
    try {
      upstreamResponse = await callUpstream(body, route, upstream);
    } catch (e) {
      if (e instanceof UpstreamError) {
        audit(502, false);
        return errors.upstreamUnreachable(e.upstreamName, e.detail);
      }
      throw e;
    }
    const ct = upstreamResponse.headers.get("content-type") ?? "";
    if (!upstreamResponse.ok) {
      audit(upstreamResponse.status, false, {
        latency_ms: { total: Date.now() - started, upstream: Date.now() - upstreamStarted },
      });
      return relayResponse(upstreamResponse);
    }
    if (ct.includes("event-stream")) {
      return streamUpstream(upstreamResponse, {
        ctx,
        route,
        opts,
        priorVerdicts: verdicts,
        maskedSoFar: masked,
        shimInfo,
        loopInfo,
        onComplete: ({ verdicts: v, masked: m, restored: r, usage }) => {
          audit(200, false, {
            verdicts: v,
            masked: m,
            restored: r,
            latency_ms: { total: Date.now() - started, upstream: Date.now() - upstreamStarted },
            ...(usage ? { usage } : {}),
          });
        },
      });
    }
    // The upstream ignored stream:true and returned JSON — process it through
    // the buffered path below and re-stream via completionToSSE, so policy /
    // secrets are still applied (never relay a tool call unprocessed).
    try {
      responseBody = (await upstreamResponse.json()) as Record<string, unknown>;
    } catch {
      audit(upstreamResponse.status, false);
      return errors.upstreamUnreachable(upstream.name, "upstream returned unparseable JSON");
    }
  } else if (choice !== null) {
    // Shimmed strategies (and native non-stream): buffer so the calls can be
    // parsed, validated, repaired, and run through tool-policy.
    const maxAttempts =
      typeof (route.repair as Record<string, unknown> | undefined)?.max_attempts === "number"
        ? ((route.repair as Record<string, unknown>).max_attempts as number)
        : 2;
    let run;
    try {
      run = await runToolShim(body, route, upstream, choice.strategy, maxAttempts);
    } catch (e) {
      if (e instanceof UpstreamError) {
        audit(502, false);
        return errors.upstreamUnreachable(e.upstreamName, e.detail);
      }
      throw e;
    }
    if (run.upstreamErrorResponse) {
      audit(run.upstreamErrorResponse.status, false);
      return relayResponse(run.upstreamErrorResponse);
    }
    if (run.parseError && choice.strategy.name === "native") {
      opts.capabilities.noteParseFailure(route, upstream);
    }
    shimInfo = { ...shimInfo, repairs: run.repairs, ...(run.parseError ? { parse_error: run.parseError } : {}) };
    responseBody = run.body;
  } else {
    // No tools, non-streaming: a plain call.
    let upstreamResponse: Response;
    try {
      upstreamResponse = await callUpstream(body, route, upstream);
    } catch (e) {
      if (e instanceof UpstreamError) {
        audit(502, false);
        return errors.upstreamUnreachable(e.upstreamName, e.detail);
      }
      throw e;
    }
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    if (!upstreamResponse.ok || !contentType.includes("application/json")) {
      audit(upstreamResponse.status, false, {
        latency_ms: { total: Date.now() - started, upstream: Date.now() - upstreamStarted },
      });
      return relayResponse(upstreamResponse);
    }
    try {
      responseBody = (await upstreamResponse.json()) as Record<string, unknown>;
    } catch {
      audit(upstreamResponse.status, false);
      return errors.upstreamUnreachable(upstream.name, "upstream returned unparseable JSON");
    }
  }
  const upstreamMs = Date.now() - upstreamStarted;

  // ── Pipeline OUT ───────────────────────────────────────────────
  const segments = responseSegments(responseBody);
  // Detect new leaks on the raw model output FIRST, then restore placeholders
  // — the other order would re-mask what mask & restore just put back.
  const outbound = await scan(segments, "response", opts.detectors, ctx, opts.onDetectorError);
  verdicts.push(...outbound.verdicts);
  masked += outbound.masked;
  if (outbound.blocked) {
    audit(200, true);
    return blockedResponse(ctx, outbound.blocked);
  }
  restored = restore(segments, ctx);

  // Tool-call policy (§5.3): evaluated on the final, reconstructed tool calls
  // (after restore), so it sees the real values the agent would execute and
  // works for shimmed models too.
  const policy = await applyToolPolicy(responseBody, opts.detectors, ctx, opts.onDetectorError);
  verdicts.push(...policy.verdicts);

  // Normalize the model name to the exposed one and attach namespaced
  // foxfence metadata (§8) when the pipeline actually did something.
  responseBody.model = route.expose;
  const repairs = typeof shimInfo?.repairs === "number" ? (shimInfo.repairs as number) : 0;
  const policyActive = policy.blocked.length > 0 || policy.flagged.length > 0;
  if (verdicts.length > 0 || shimInfo || policyActive || loopInfo) {
    responseBody.foxfence = {
      ...(typeof responseBody.foxfence === "object" ? responseBody.foxfence : {}),
      ...(verdicts.length > 0 ? { verdicts, masked, restored } : {}),
      ...(shimInfo ? { shim: shimInfo } : {}),
      ...(loopInfo ? { loop: loopInfo } : {}),
      ...(policyActive
        ? { tool_policy: { blocked: policy.blocked, flagged: policy.flagged } }
        : {}),
    };
  }

  const usage = responseBody.usage as Record<string, number> | undefined;
  audit(200, false, {
    latency_ms: { total: Date.now() - started, upstream: upstreamMs },
    ...(usage ? { usage } : {}),
    ...(opts.auditIncludeContent
      ? { content: { request: body.messages, response: responseBody.choices } }
      : {}),
  });

  const headers = new Headers();
  if (repairs > 0) headers.set("x-foxfence-repairs", String(repairs));
  if (policy.blockedAny) headers.set("x-foxfence-blocked", "true");
  if (loopInfo) headers.set("x-foxfence-loop", "nudge");
  if (ctx.stream) return completionToSSE(responseBody, headers);
  return Response.json(responseBody, { status: 200, headers });
}
