# Architecture Spec — Model Reliability & Safety Module for Agents

**Status**: Architecture & design reference (implemented — see README.md for
current usage)
**License**: Apache 2.0
**Stack**: TypeScript / Bun (single binary via `bun build --compile`)
**Name**: `foxfence` — published by Zenfox AI LTD

---

## 1. Vision

An open source, drop-in, stateless module that sits between an agent
(OpenClaw, Hermes, Aider, Cline, any OpenAI-compatible client) and any model
(Ollama, vLLM, OpenRouter, Together, proprietary APIs).

**One-sentence value proposition:**

> Plug any cheap model into your agent: it becomes both more capable and
> safer.

Two functions, one wire:

1. **Capability shim** — make tool calling and structured output reliable for
   open-source/budget models that don't support them natively (or support
   them poorly).
2. **Safety layer** — inline detectors on requests and responses:
   secret/PII masking, prompt injection detection, tool-call policy
   enforcement.

What this module is **not**:

- Not an agentic loop. One `/chat/completions` call = one model turn,
  enriched. Never multiple autonomous calls hidden behind the API (with the
  single exception of the bounded repair loop, see §6.4).
- Not an enterprise multi-tenant gateway (no DB, no frontend, no user
  management). That's OpenGuardrails/Portkey territory.
- Not a general-purpose cost router. That's LiteLLM/OpenRouter territory.

## 2. Design principles

1. **Stateless** — no business state between requests. No DB, no sessions.
   All context comes from the request. Horizontally scalable, hot-restartable,
   trivially auditable. *Single tolerated exception: the in-memory cache of
   detected model capabilities (§6.1) — reconstructible at any time, lost
   harmlessly on restart.*
2. **One config file** — a single declarative `foxfence.yaml`. No admin console.
   The config IS the documentation of behavior.
3. **Tiny core, pluggable periphery** — the core only does: HTTP, SSE
   streaming, format translation, pipeline orchestration. Every safety
   detector and every shim strategy is a plugin with a stable interface.
4. **Transparent by default** — if no rule matches, the request passes
   through unchanged, byte-for-byte as much as possible. The module must
   never degrade a model that already works well.
5. **Auditable** — deliberately small codebase (< 10 kLOC target for the
   core), zero telemetry, minimal pinned dependencies. This is a security
   component: its attack surface is its first quality criterion.
6. **Configurable fail-closed** — when a safety detector errors out, the
   behavior (block or pass) is explicit in the config, never implicit.

## 3. Overall architecture

```
                       ┌──────────────────────────── foxfence ───────────────────────────┐
                       │                                                              │
 Agent                 │  ┌─────────┐   ┌──────────────┐   ┌───────────────────────┐  │       Model
 (OpenClaw, Hermes,    │  │ Ingress │ → │ Pipeline IN  │ → │ Upstream adapter      │  │  (Ollama, vLLM,
  Aider, Cline...)   ──┼─→│ OpenAI  │   │ - safety     │   │ - tool-calling shim   │──┼─→ OpenRouter,
                       │  │ API     │   │ - transforms │   │ - format translation  │  │   Together...)
                       │  └─────────┘   └──────────────┘   └───────────┬───────────┘  │
                       │                                               │              │
                       │  ┌─────────┐   ┌──────────────┐   ┌───────────▼───────────┐  │
                     ←─┼──│ Egress  │ ← │ Pipeline OUT │ ← │ Model output parser   │←─┼──
                       │  │ SSE/JSON│   │ - safety     │   │ / repairer            │  │
                       │  └─────────┘   └──────────────┘   └───────────────────────┘  │
                       └──────────────────────────────────────────────────────────────┘
```

Four stages traversed by every request:

1. **Ingress** — OpenAI-compatible endpoint (`/v1/chat/completions`,
   `/v1/models`, later `/v1/responses`). Schema validation, target model and
   route extraction.
2. **Pipeline IN** — middleware chain on the request: safety detectors
   (secrets, PII, injection), transforms (system prompt injection,
   rewriting), then shim preparation if the target model needs it.
3. **Upstream** — the model call. The adapter knows the model's *effective
   capabilities* (§6.1) and picks the strategy: native passthrough or
   prompted shim.
4. **Pipeline OUT** — output parsing/repair (tool calls), outbound safety
   detectors (tool-call policy, secret leakage), then re-serialization to the
   exact OpenAI format, streamed if requested.

## 4. TypeScript interfaces (core)

```typescript
// ── Pivot types ──────────────────────────────────────────────
// The internal pivot format is the OpenAI Chat Completions format.
// Every upstream adapter translates to/from this pivot.

interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  stream?: boolean;
  // ... standard OpenAI fields, passthrough for everything else
}

interface ChatResponse {
  choices: Choice[];        // incl. message.tool_calls in OpenAI format
  usage: Usage;             // real upstream tokens + shim overhead, separated
  foxfence?: FoxfenceMetadata;    // extension: safety verdicts, repairs, latency
}

// ── Plugin: safety detector ──────────────────────────────────
interface Detector {
  name: string;
  phase: "request" | "response" | "tool_call";
  /** Stateless: receives content, returns a verdict. Never side-effects. */
  inspect(input: DetectorInput, ctx: RequestContext): Promise<Verdict>;
}

type Verdict =
  | { action: "pass" }
  | { action: "block"; reason: string; userMessage?: string }
  | { action: "mask"; replacements: Replacement[] }   // mask & restore
  | { action: "flag"; reason: string };               // log only

interface Replacement {
  original: string;       // kept in memory for the lifetime of the request only
  placeholder: string;    // e.g. __secret_1__
  restore: boolean;       // restore in the response?
}

// ── Plugin: shim strategy ────────────────────────────────────
interface ToolShimStrategy {
  name: string;                       // e.g. "native", "json-prompted", "react"
  /** Does the model support this strategy? */
  supports(caps: ModelCapabilities): boolean;
  /** Transforms the request: injects tools into the prompt if needed. */
  encode(req: ChatRequest, caps: ModelCapabilities, profile?: ModelProfile): UpstreamRequest;
  /** Parses raw model output into clean OpenAI tool calls. */
  decode(raw: UpstreamChunk[] | string, req: ChatRequest): DecodeResult;
}

type DecodeResult =
  | { ok: true; response: ChatResponse }
  | { ok: false; error: ParseError; repairHint: string }; // triggers repair loop

// ── Model capabilities ───────────────────────────────────────
// Produced by the auto probe (§6.1) OR declared via an optional profile.
interface ModelCapabilities {
  toolCalling: "native" | "weak" | "none";
  parallelToolCalls: boolean;
  jsonMode: "native" | "prompted" | "none";
  source: "probe" | "profile" | "runtime-downgrade";
}

// Optional profile: pins the strategy and/or describes quirks
// the probe can't detect.
interface ModelProfile {
  id: string;                          // e.g. "qwen2.5-7b-instruct"
  capabilities?: Partial<ModelCapabilities>;  // overrides the probe
  pinStrategy?: string;                // disables probe + runtime fallback
  contextWindow?: number;
  chatTemplateQuirks?: string[];       // e.g. ["no-system-role", "hermes-tool-format"]
}
```

Plugin golden rule: **pure and stateless**. A detector that needs an ML model
(e.g. an injection classifier) calls it over HTTP — the detection model is an
optional external service, never embedded in the core.

## 5. Safety pipeline

### 5.1 Detectors shipped with the MVP

| Detector | Phase | Technique | Default action |
|---|---|---|---|
| `secrets` | request + response | High-precision regex (AWS/GCP keys, GitHub/Slack tokens, PEM private keys, connstrings) + entropy | `mask` (mask & restore) |
| `pii-basic` | request | Regex (emails, phone numbers, cards) | `flag` |
| `prompt-injection` | request (tool-sourced content) | Heuristics + optional external classifier | `flag` (MVP), `block` (v1) |
| `tool-policy` | tool_call | Declarative allow/deny list on tool name + arguments (glob/regex) | per config |
| `egress-allowlist` | request | The module only talks to upstreams declared in config | `block` (always) |

### 5.2 External detectors (reuse without forking)

The `Detector` interface admits a `remote` type that POSTs content to a
compatible service. This allows plugging in:

- **LLM Guard** (Python scanners, MIT) behind a small HTTP server;
- **OpenGuardrails-Text-2510** (3.3B model, HuggingFace) via vLLM/Ollama;
- any in-house classifier.

The core stays tiny; heavy detection is opt-in and external.

### 5.3 Tool-call policy (the safety differentiator)

This is the most important detector for OpenClaw-style agents: it sees tool
calls **after parsing/repair**, so it works even for models with no native
tool calling — something no text-level firewall can do cleanly.

```yaml
tool_policy:
  default: allow          # or "deny" for paranoid mode
  rules:
    - tool: "exec"
      args: { command: "*rm -rf*" }
      action: block
    - tool: "browser_*"
      args: { url: "!https://*.internal.corp/*" }   # negation = outside allowlist
      action: flag
    - tool: "send_email"
      action: block
      message: "Email sending disabled by foxfence policy."
```

A `block` on a tool call returns an explicit error tool message to the agent
(role `tool`, content like "blocked by policy: <reason>") rather than an HTTP
error — so the agent can recover gracefully.

## 6. Tool-calling shim (the heart of the project)

### 6.1 Capability detection: `auto` mode by default, optional profiles

The API format (OpenAI in/out) is uniform, but the actual behavior of the
models behind it is not: a Qwen 7B accepts `tools` yet hallucinates
out-of-schema arguments; an older model ignores tools and answers in plain
text. The module therefore needs to know the model's *effective capabilities*
to pick its strategy — but that knowledge doesn't have to be hand-declared.

**`auto` mode (default, zero config):**

1. **Initial probe** (lazy, on first call to a model — or eager at startup
   with `probe: startup`): the module sends a canonical mini tool-call
   request (one trivial tool, deterministic expected answer) and classifies
   the result: `native` (valid tool_call), `weak` (tool_call present but
   malformed), `none` (plain text).
2. **Runtime fallback**: if a model classified `native` returns text where
   `tool_choice` required a call, or produces invalid tool calls repeatedly
   (configurable threshold), the module downgrades the strategy
   (`native` → `constrained`/`json-prompted`) and logs it to the audit trail.
3. **In-memory cache**: the verdict is memoized for the process lifetime
   (key: upstream + model). It's a reconstructible cache, not business state —
   see principle #1. Lost on restart: probing starts over.

**Profiles (optional, two uses):**

- *Pinning*: force a strategy when you want deterministic behavior in prod
  (no probing, no runtime downgrade).
- *Fine-grained quirks* the auto probe can't catch at reasonable cost:
  sporadic schema hallucinations, chat template peculiarities, missing system
  role, parallel-call formats.

The bundled YAML registry thus becomes a **community cache of observations**
rather than a hard dependency — you start with nothing, and contribute a
profile when you've learned something the probe can't see.

### 6.2 Strategies (in order of preference)

1. **`native`** — passthrough: the model/server (vLLM, recent Ollama) handles
   tools natively. The shim touches nothing. *Always preferred when reliable.*
2. **`constrained`** — if the upstream exposes constrained structured output
   (llama.cpp GBNF grammars, vLLM `guided_json`, OpenAI json_schema): tool
   definitions are converted into a union JSON Schema and the server
   constrains decoding. Maximum reliability for weak models.
3. **`json-prompted`** — inject a system block describing the tools + a
   mandated JSON output format, with tolerant output parsing (extract the
   first valid JSON object, tolerate markdown fences, trailing commas, etc.).
4. **`react`** — `Thought/Action/Action Input` format for old or very small
   models that can't hold JSON. Last resort.

### 6.3 Encoding (example: `json-prompted`)

The shim adds a system message (or merges with the existing one):

```
You have access to the following tools. To call a tool, reply ONLY
with a JSON object of the form:
{"tool_call": {"name": "<name>", "arguments": {...}}}
To answer the user without a tool:
{"final": "<your answer>"}

Available tools:
- exec(command: string): Executes a shell command. ...
[compact JSON schemas generated from req.tools]
```

Points of attention: token budget of the block (schema compression,
descriptions truncated beyond a configurable threshold), respecting chat
template quirks, and preserving `tool_choice` (forcing a tool = constrained
schema on that tool only).

### 6.4 Decoding and repair loop (bounded, transparent)

```
raw output → strict parse → ok? → clean OpenAI response
                  │ fail
                  ▼
             tolerant parse (fences, partial JSON, args as string)
                  │ fail
                  ▼
             repair loop: send back to the model with the precise error
             ("your JSON is invalid: <error>, return only the corrected object")
             → max N attempts (default 2), capped token budget
                  │ final failure
                  ▼
             standard OpenAI error (finish_reason: "error" + foxfence.parse_error)
```

This is the **only** exception to "one call = one turn", and it is: bounded
(configurable N), accounted for (repair tokens in `foxfence.overhead`), visible
(`X-Foxfence-Repairs: 1` header), and can be disabled.

Tool arguments are systematically validated against the tool's JSON Schema
**before** returning to the agent: a mistyped tool call is repaired or
rejected, never forwarded as-is. This is both reliability and safety (an
agent that receives clean arguments is harder to exploit via injection).

### 6.5 Streaming

- `native` strategy: chunk-by-chunk SSE passthrough.
- Shimmed strategies: minimal buffering needed for parsing — final text is
  re-streamed as soon as we know it's not a tool call; a tool call is emitted
  as conformant `tool_calls` chunks once parsed. The client never sees the
  intermediate format.

## 7. Configuration (`foxfence.yaml`)

```yaml
listen: 127.0.0.1:4100
api_keys: [ "${FOXFENCE_KEY}" ]          # keys accepted on the agent side

upstreams:
  - name: local-ollama
    base_url: http://localhost:11434/v1
  - name: openrouter
    base_url: https://openrouter.ai/api/v1
    api_key: "${OPENROUTER_KEY}"

models:
  # name exposed to the agent → upstream + real model. That's all that's
  # required: capabilities are probed automatically (§6.1).
  - expose: qwen-tools
    upstream: local-ollama
    model: qwen2.5:7b-instruct
    shim: auto                        # default. auto | native | constrained | json-prompted | react
    probe: lazy                       # lazy (default) | startup | off
    profile: qwen2.5-7b-instruct      # OPTIONAL: pinning / quirks (registry or inline)
    repair: { max_attempts: 2 }

transforms:
  system_prepend: |                   # declarative prompt engineering
    Always answer in French.

security:
  on_detector_error: block            # fail-closed
  detectors:
    secrets:   { action: mask }
    pii-basic: { action: flag }
    prompt-injection:
      action: flag
      remote: http://localhost:8800/classify   # optional
  tool_policy:
    default: allow
    rules:
      - { tool: exec, args: { command: "*rm -rf*" }, action: block }

audit:
  file: ./foxfence-audit.jsonl           # local JSONL, no telemetry
  include_content: false              # default: metadata only
```

## 8. API compatibility

- MVP endpoints: `POST /v1/chat/completions` (stream and non-stream),
  `GET /v1/models` (lists `expose`d models), `GET /healthz`.
- Errors in standard OpenAI format (`error.type`, `error.code`); safety
  blocks use `finish_reason: "content_filter"` + an `X-Foxfence-Blocked: true`
  header (Trylon-compatible convention).
- Namespaced extensions: `foxfence` field in responses and `X-Foxfence-*` headers,
  never modifying standard OpenAI fields.
- Usage: `usage` reflects real upstream tokens; shim overhead (tool prompt,
  repairs) is detailed in `foxfence.overhead` for honest cost accounting.

## 9. Observability & audit

- Local JSONL audit log: timestamp, model, shim strategy used, detector
  verdicts, repair count, latencies (upstream vs module), tokens. Message
  content excluded by default (opt-in).
- `GET /metrics` Prometheus (opt-in): added latency, repair rate per model,
  verdicts per detector.
- Performance target: < 5 ms added overhead p50, excluding external ML
  detectors.

## 10. Security of the module itself

- Zero telemetry, zero network calls outside declared upstreams (the egress
  allowlist applies to the module itself).
- Secrets via environment variables only; never written to the audit log;
  mask & restore lives in memory only, lifetime = the request.
- Pinned dependencies + `bun audit` in CI; signed binary releases;
  SECURITY.md with a disclosure process.
- The repair loop has a global per-request token cap (protection against
  injection-induced expensive loops).

## 11. Testing & evaluation

1. **API conformance** — golden suite: the official OpenAI SDK (Python + JS)
   must work unmodified against the module, streaming included.
2. **Tool-calling eval** — BFCL-style harness (Berkeley Function Calling
   Leaderboard) run against a {model × strategy} matrix; the README publishes
   the "valid tool-call rate with/without foxfence" table. *This is the
   project's #1 marketing argument: it must be reproducible via
   `bun run eval`.*
3. **Safety red team** — corpus of known injections (jailbreaks via tool
   content, secret exfiltration) as non-regression tests.
4. **Reference integration** — OpenClaw + foxfence + Ollama config documented
   and tested in CI (docker-compose smoke test).

## 12. Roadmap

**MVP (v0.1)** — `/v1/chat/completions` + streaming; `native` and
`json-prompted` strategies; auto probe + runtime fallback; repair loop;
`secrets`, `tool-policy`, `egress-allowlist` detectors; OpenClaw integration
doc.

**v0.2** — `constrained` strategy (vLLM `guided_json`, GBNF); `remote`
detectors; published eval harness; full mask & restore; first community
profiles (Qwen, Llama, Mistral, DeepSeek, Gemma quirks).

**v1.0** — `react` strategy; `prompt-injection` in block mode; community
profile registry (dedicated CONTRIBUTING); `/v1/responses`; Prometheus
metrics; signed multi-platform binaries.

**Explicitly out of scope** (refer to LiteLLM/OpenGuardrails): multi-tenant,
billing, admin UI, load balancing, semantic caching.

## 13. Repo structure

```
foxfence/
├── src/
│   ├── server.ts            # HTTP ingress + SSE
│   ├── pipeline.ts          # IN/OUT orchestration
│   ├── pivot/               # OpenAI pivot types + validation
│   ├── shim/
│   │   ├── strategy.ts      # ToolShimStrategy interface
│   │   ├── probe.ts         # auto capability detection (§6.1)
│   │   ├── native.ts
│   │   ├── json-prompted.ts
│   │   ├── constrained.ts
│   │   └── repair.ts
│   ├── security/
│   │   ├── detector.ts      # Detector interface
│   │   ├── secrets.ts
│   │   ├── tool-policy.ts
│   │   └── remote.ts
│   ├── upstream/            # adapters + HTTP client
│   └── config/              # zod schema for foxfence.yaml
├── profiles/                # model profile registry (YAML, optional)
├── eval/                    # BFCL-like harness + red team corpus
├── examples/
│   ├── openclaw/            # OpenClaw + foxfence + Ollama config
│   └── docker-compose.yml
├── docs/
├── LICENSE                  # Apache 2.0
├── SECURITY.md
└── README.md
```

---

*This is the original design document; the implementation realizes it in full
(with some deliberate, documented refinements noted in the README). See the
README for installation and current behavior.*
