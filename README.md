# foxfence

Model reliability & safety module for agents. An OpenAI-compatible proxy that
sits between any agent and any model, making cheap models more capable
(tool-calling shim) and safer (inline detectors). See
[SPEC-architecture.md](./SPEC-architecture.md) for the full design.

**Status: v0.2 complete; v1.0 in progress.** The OpenAI SDK works unmodified
against foxfence, streaming included. Requests and responses flow through
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
- `GET /v1/models` — lists exposed models.
- `GET /healthz` — liveness (no auth).
- Agent-side API keys (`api_keys`), upstream-side key injection (the agent's
  key is never forwarded upstream).
- Errors in standard OpenAI wire format.
- Single-binary build: `bun run build` → `dist/foxfence`.

### Safety pipeline (phase 2)

- `secrets` detector — high-precision patterns (AWS/GCP/GitHub/Slack/Stripe
  keys, `sk-*` API keys behind an entropy gate, PEM private keys, connection
  strings, JWTs). Default `mask`: secrets in requests are replaced with
  placeholders before going upstream and restored in the response (mask &
  restore); new secrets appearing in model output are permanently redacted.
- `pii-basic` detector — emails, phone numbers, Luhn-validated cards.
  Default `flag` (audit-only, traffic untouched).
- **Remote detectors** (v0.2, §5.2) — give any detector a `remote:` classifier
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

### Tool-calling shim (phase 3)

- **`auto` mode (default, zero config)** — on the first tools request per
  model, foxfence sends a canonical mini tool-call probe and classifies the
  model `native` / `weak` / `none` (single-flight, memoized in memory for the
  process lifetime). Native models get pure passthrough; the rest get the
  `json-prompted` strategy.
- **`json-prompted` strategy** — tools are described in an injected system
  block mandating a JSON protocol; conversation history with `tool` messages
  is rewritten for models that reject them; output parsing is tolerant
  (fences, prose around the object, arguments-as-string).
- **`constrained` strategy** (v0.2) — when an upstream declares a
  constrained-decoding mechanism (`constrained: response_format | guided_json`
  for OpenAI/vLLM `json_schema` or vLLM's extra field), foxfence sends a
  per-tool union JSON Schema so the server can only emit a well-formed call.
  `auto` prefers it over `json-prompted` whenever the upstream supports it.
- **`react` strategy** (v1.0) — a `Thought / Action / Action Input` format for
  old or very small models that can't reliably hold JSON. Parsing is forgiving
  (a bare `Action Input: Paris` maps onto a one-argument tool). Opt-in only via
  `shim: react` or a profile `pinStrategy: react` — `auto` never selects it.
- **Model profiles** (v0.2, [`profiles/`](./profiles/)) — pin a model's
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
- **Incremental streaming** (v1.0, §6.5) — native and tool-free streams go out
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

### Tool-call policy (phase 4)

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

The project's headline claim (§11.2): a cheap model becomes reliable at tool
calling behind foxfence. `bun run eval` measures it and prints a table.

```sh
bun run eval                                   # bundled simulated weak model
bun run eval --endpoint http://localhost:11434/v1 --model qwen2.5:7b-instruct
bun run eval --out eval/results.md             # write the table to a file
```

The bundled run uses a deterministic simulated model with *no native tool
calling*, so it scores 0% called directly and ~86% behind the `json-prompted`
shim — see [`eval/results.md`](./eval/results.md). The corpus lives in
[`eval/cases/`](./eval/cases/) (validated at load: every expected call must
conform to its tool's JSON Schema); the scorer is in `eval/score.ts`. Run real
models with `--endpoint` and contribute their tables.

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
