# foxfence

Model reliability & safety module for agents. An OpenAI-compatible proxy that
sits between any agent and any model, making cheap models more capable
(tool-calling shim) and safer (inline detectors). See
[SPEC-architecture.md](./SPEC-architecture.md) for the full design.

Feature-complete and validated against real models. foxfence speaks the Chat
Completions and Responses APIs, ships all four shim strategies, the full safety
pipeline, incremental streaming, Prometheus metrics, model profiles, and signed
multi-platform binaries. The OpenAI SDK works unmodified against it, streaming
included. Requests and responses flow through
inline safety detectors (with optional external classifiers), tool calling
works even for models with no native support (`native` / `json-prompted` /
`constrained` / `react` strategies + a bounded repair loop), a declarative
policy is enforced on the parsed tool calls, native and tool-free responses
stream token-by-token with full safety, model profiles pin
capabilities/quirks, and a reproducible eval harness measures the tool-calling
improvement. A reference OpenClaw + Ollama integration ships in
[`examples/`](./examples/).

## Quick start

```sh
bun install
cp foxfence.example.yaml foxfence.yaml   # then point it at your upstream
bun start                                # or: bun run dev (watch mode)
```

Point your agent at `http://127.0.0.1:4100/v1` and use the `expose`d model
names from your config.

## What works today

- `POST /v1/chat/completions` — transparent passthrough, stream and
  non-stream. The request `model` is rewritten from the exposed name to the
  upstream's real model id; everything else is forwarded untouched.
- `POST /v1/responses` — the OpenAI Responses API, translated to the chat
  pivot so every shim and safety feature applies unchanged (non-streaming;
  streaming on this surface is rejected with a clear error for now).
- `GET /v1/models` — lists exposed models.
- `GET /metrics` — opt-in Prometheus scrape (`metrics.enabled: true`): requests,
  blocks, repairs, and detector verdicts per model, plus overhead/upstream
  latency histograms. Unauthenticated like `/healthz` — network-restrict it.
- `GET /healthz` — liveness (no auth).
- Agent-side API keys (`api_keys`), upstream-side key injection (the agent's
  key is never forwarded upstream).
- Errors in standard OpenAI wire format.
- Single-binary build: `bun run build` → `dist/foxfence`.

### Safety pipeline

- `secrets` detector — high-precision patterns (AWS/GCP/GitHub/Slack/Stripe
  keys, `sk-*` API keys behind an entropy gate, PEM private keys, connection
  strings, JWTs). Default `mask`: secrets in requests are replaced with
  placeholders before going upstream and restored in the response (mask &
  restore); new secrets appearing in model output are permanently redacted.
- `pii-basic` detector — emails, phone numbers, Luhn-validated cards.
  Default `flag` (audit-only, traffic untouched).
- **Remote detectors** (§5.2) — give any detector a `remote:` classifier
  URL and foxfence POSTs each segment to it, mapping the reply to a verdict;
  this is how `prompt-injection` is enabled (LLM Guard, OpenGuardrails, or an
  in-house model behind a small HTTP server). Optional `roles:` targets e.g.
  tool-sourced content; a `timeout_ms` (default 2000) bounds the call, and a
  failure/timeout is governed by the fail-closed policy. The core stays tiny —
  heavy detection is opt-in and external.
- Per-detector actions in config: `pass | flag | mask | block | off`.
  Blocks return a normal completion with `finish_reason: "content_filter"`
  and an `X-Foxfence-Blocked: true` header, so agents recover gracefully.
- Fail-closed by default: a crashing detector blocks the request
  (`security.on_detector_error: pass` to opt out).
- JSONL audit trail (`audit.file`): verdicts, mask/restore counts, latencies,
  tokens — message content excluded unless `include_content: true`.
- Pipeline verdicts surface in a namespaced `foxfence` field on non-stream
  responses; standard OpenAI fields are never altered (except `model`, which
  is normalized back to the exposed name).

### Tool-calling shim

- **`auto` mode (default, zero config)** — on the first tools request per
  model, foxfence sends a canonical mini tool-call probe and classifies the
  model `native` / `weak` / `none` (single-flight, memoized in memory for the
  process lifetime). Native models get pure passthrough; the rest get the
  `json-prompted` strategy.
- **`json-prompted` strategy** — tools are described in an injected system
  block mandating a JSON protocol; conversation history with `tool` messages
  is rewritten for models that reject them; output parsing is tolerant
  (fences, prose around the object, arguments-as-string).
- **`constrained` strategy** — when an upstream declares a
  constrained-decoding mechanism (`constrained: response_format | guided_json`
  for OpenAI/vLLM `json_schema` or vLLM's extra field), foxfence sends a
  per-tool union JSON Schema so the server can only emit a well-formed call.
  `auto` prefers it over `json-prompted` whenever the upstream supports it.
- **`react` strategy** — a `Thought / Action / Action Input` format for
  old or very small models that can't reliably hold JSON. Parsing is forgiving
  (a bare `Action Input: Paris` maps onto a one-argument tool). Opt-in only via
  `shim: react` or a profile `pinStrategy: react` — `auto` never selects it.
- **Model profiles** ([`profiles/`](./profiles/)) — pin a model's
  capabilities/strategy or record a chat-template quirk (e.g. Gemma's
  `no-system-role`) the probe can't see. Reference by id (`profile: gemma-2`)
  or inline. Precedence: route `shim:` > `pinStrategy` > declared
  `capabilities` > probe.
- **Validation always** — tool arguments are checked against the tool's JSON
  Schema before reaching the agent, native or shimmed (§6.4).
- **Bounded repair loop** — an invalid reply goes back to the model with the
  precise error, at most `repair.max_attempts` times (default 2, 0 disables).
  Repairs are visible: `X-Foxfence-Repairs` header + `foxfence.shim.repairs`.
  Final failure is a completion with `finish_reason: "error"` and
  `foxfence.parse_error`.
- **Runtime downgrade** — a model classified native that repeatedly fails
  parsing is downgraded to `json-prompted` and the event is logged.
- **Pinning** — `shim: native` or `shim: json-prompted` skips probing for
  deterministic production behavior; `probe: startup` probes eagerly,
  `probe: off` assumes native.
- **Incremental streaming** (§6.5) — native and tool-free streams go out
  token-by-token: content is sanitized on the fly (mask & restore + secret
  redaction that never leaks a partial secret across chunks), and a native tool
  call is assembled, validated, and run through tool-policy before being
  emitted as conformant `tool_calls` chunks. Shimmed strategies
  (`json-prompted` / `constrained` / `react`) still buffer the reply to parse
  it, then re-stream via SSE — the client never sees the intermediate format.
  Documented streaming tradeoffs (use non-streaming for the stricter
  guarantees): a response-phase secret **block** degrades to **redact** (you
  can't un-send streamed bytes); on streamed *content* only the secrets
  sanitizer runs, so a response-phase `remote` classifier applies to tool calls
  but not to streamed text; and a native tool call's arguments are
  secret-scanned, restored, and policy-checked but **not** schema-repaired
  (repair needs a fresh turn). A real upstream transport error mid-stream is
  surfaced as `foxfence.stream_error` on the final chunk rather than passed off
  as a clean completion.

### Loop-breaker

Small and self-hosted models share a failure mode native APIs don't fix: when a
tool call fails, the model often re-emits the **identical call** instead of
adapting, and the agent spins in an infinite retry loop. foxfence detects this
from the request history alone (it stays stateless — nothing is remembered
between requests) and steps in.

- **Detection** — when the most recent assistant turns are the same tool call
  (same name + arguments, compared structurally so key order and whitespace
  don't hide a repeat) repeated `threshold` times in a row, it's a stuck loop.
  Healthy traffic never trips this, so it's **on by default**.
- **`nudge` (default)** — foxfence appends a short corrective system message to
  the request ("you've already called `X` N times with these arguments and it
  didn't work — fix the arguments, try a different tool, or stop and explain")
  and forwards it. The model gets a chance to recover on its own.
- **`break`** — foxfence stops the loop deterministically *without another model
  call*, returning a normal assistant completion that explains it broke the
  retry loop. Use this when you want a hard cap rather than a hint.
- **Visible** — an intervention sets the `X-Foxfence-Loop` header (`nudge` or
  `break`) and a `foxfence.loop` field (`{ tool, count, action }`).

```yaml
models:
  - expose: my-model
    upstream: local-ollama
    model: qwen2.5:7b-instruct
    loop_breaker:
      enabled: true       # default true; set false to turn off
      threshold: 3        # identical repeats before intervening (default 3)
      action: nudge       # nudge (default) | break
```

### Re-grounding (state drift)

The companion failure mode: over a long, tool-heavy conversation, small models
drift off-distribution and start **ignoring their original system
instructions** (the constraint that said "read-only", "answer in French",
"never call X"). foxfence counters this statelessly — again reading only the
request — by re-asserting the system prompt where the model will actually weigh
it.

- **Detection** — once the history carries `after_tool_results` tool results
  (default 6) *and* there is a system message, the conversation is considered
  drift-prone. On by default.
- **Re-assertion** — foxfence appends a compact reminder near the end of the
  request ("your original instructions are still in effect: …"), carrying the
  original system text truncated to `max_chars` (default 600) so a long prompt
  can't blow the token budget. It is **additive** — existing turns are never
  dropped or rewritten.
- **Visible** — sets the `X-Foxfence-Reground` header and a `foxfence.reground`
  field (`{ tool_results }`).

```yaml
models:
  - expose: my-model
    upstream: local-ollama
    model: qwen2.5:7b-instruct
    reground:
      enabled: true            # default true; set false to turn off
      after_tool_results: 6    # tool results before re-asserting (default 6)
      max_chars: 600           # truncate the re-asserted prompt (default 600)
```

### Tool-call policy

The safety differentiator (§5.3): a declarative allow/deny policy enforced on
tool calls *after* parsing/repair, so it works even for models with no native
tool calling — something a text-level firewall can't do cleanly. Configured
under `security.tool_policy` (see `foxfence.example.yaml`).

- **Matching** — `tool` and per-argument patterns are globs (`*` any run, `?`
  any char) or `/regex/flags`; a leading `!` negates (use for "outside the
  allowlist"). Globs are anchored full-match, **case-insensitive** (casing
  can't evade a rule), and compiled dotAll so `*` spans newlines (closing the
  `ls\nrm -rf /` bypass). Object/array args are matched as their JSON form.
  Rules are first-match-wins.
- **`default: allow | deny`** — `deny` is allowlist mode: any call not matched
  by an `allow` rule is blocked.
- **Actions** — `block`, `flag`, or `allow`. A **block removes the offending
  call** from the assistant turn. If no calls remain, the policy reason is put
  in the message content and `finish_reason` becomes `stop` (in-band feedback
  the agent can recover from); if allowed sibling calls remain, they are kept
  with `finish_reason: tool_calls` and content left null (the block is then
  surfaced only via metadata + header, since OpenAI clients may reject content
  set alongside tool_calls). Every block sets `X-Foxfence-Blocked: true` and
  `foxfence.tool_policy`. **flag** keeps the call and records it.
- **Validated at startup** — every glob/regex is compiled when the server
  boots, so a bad pattern (or a `(x+)+`-style catastrophic regex) is a startup
  error, not a per-request surprise.

> **Deliberate spec deviation.** §5.3 describes a block as returning a
> `role: tool` error message. A single `/chat/completions` response is always
> one `role: assistant` turn, so a `tool` message isn't expressible there;
> foxfence instead returns the policy reason as assistant content, which is the
> faithful, agent-recoverable equivalent.
>
> **Not a sandbox.** Argument-content matching is best-effort defense in depth
> (e.g. `*rm -rf*` won't catch `rm -r -f`). Use `default: deny` allowlisting
> for anything that truly matters, and treat matches as one layer plus an
> audit signal.

**Streaming summary:** native and tool-free streams are now token-by-token with
full safety (mask-restore + cross-chunk secret redaction + tool-call policy);
the three shimmed strategies still buffer the reply to parse it, then re-stream.
See the streaming bullet above for the two deliberate tradeoffs.

## Eval — the with/without-foxfence table

The project's headline claim (§11.2): a model becomes more reliable at tool
calling behind foxfence. `bun run eval` measures it and prints a table.

```sh
bun run eval                                              # bundled simulator
bun run eval --endpoint <url> --model <name> --key <key>  # a real model
bun run eval --endpoint <url> --model <name> --shim json-prompted  # force the shim
```

**Real-model results** ([`eval/results.md`](./eval/results.md)): foxfence
improved small native models (Qwen2.5-7B 83→90%, Llama-3.1-8B 86→100%) through
its runtime downgrade + repair loop, and forcing the prompted shim even beat
Qwen's own native path. The no-native-tools rescue case is shown
deterministically by the bundled simulator (0→~86%). The eval focuses on small /
self-hosted models — that's where foxfence helps; single-turn evals on large
frontier models just measured native parity and were dropped. The corpus lives
in [`eval/cases/`](./eval/cases/) (validated at load: every expected call must
conform to its tool's JSON Schema); the scorer is in `eval/score.ts`. Run real
models with `--endpoint` and contribute their tables.

**Multi-turn reliability (loop + drift)** — the corpus also includes `loop`
cases (a failing tool call the model re-fires identically) and `drift` cases (a
long tool-heavy chat where the model forgets a system constraint), scored by the
`loop-broke` and `drift-resist` columns. The **mechanisms are verified
deterministically** in `test/loop.test.ts` and `test/reground.test.ts` (the
nudge / re-assertion is provably injected). The *real-model* numbers on Hermes 3
(Q4 via Ollama) are small-sample and noisy — loop recovery ranged 33–67% across
runs (default `nudge`; `action: break` makes it deterministic, no extra model
call), and the 2 drift cases sat at 50% with and without (Hermes 3 isn't
drift-prone enough at this depth to need the reminder). These features target
**weaker models and longer conversations** than Hermes 3; both are additive and
low-risk, so they never degrade a model that doesn't need them. This is still
the dimension where foxfence helps small/self-hosted models — single-turn tool
calling on a capable model gains little.

A safety red-team corpus (§11.3 — secret exfiltration, injection-driven
dangerous tool calls) lives in `test/redteam.test.ts` as non-regression guards:
`bun test redteam`.

## Reference integration

[`examples/`](./examples/) wires an OpenClaw-style agent to a local Ollama model
through foxfence (§11.4): `docker compose -f examples/docker-compose.yml up
--build`, then point your agent at `http://localhost:4100/v1`. Details and the
agent settings are in [`examples/openclaw/README.md`](./examples/openclaw/README.md);
`examples/smoke.sh` verifies the wire end to end.

## Development

```sh
bun test            # full suite: conformance, config, security, shim, policy, eval, red-team
bun run typecheck   # tsc --noEmit
bun run eval        # tool-calling reliability table
bun run build       # single binary → dist/foxfence
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, and `bun audit` on every
PR; tagged releases (`.github/workflows/release.yml`) cross-compile signed,
checksummed binaries for Linux/macOS/Windows (Sigstore keyless).

## Contributing & security

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup and how to contribute a
  model [profile](./profiles/) (the most welcome kind of change).
- [`SECURITY.md`](./SECURITY.md) — responsible disclosure and the security
  posture (zero telemetry, egress allowlist, signed releases).
- [`LICENSE`](./LICENSE) — Apache 2.0.
