# Eval results

Tool-calling reliability **with and without foxfence** (§11.2). Regenerate with
`bun run eval` (bundled simulator) or
`bun run eval --endpoint <url> --model <name> --key <key>` against a real
OpenAI-compatible server. Add `--shim json-prompted` to force the capability
shim instead of the model's native tool calling.

> **Scope.** These tables cover small / self-hosted models, which is where
> foxfence earns its keep. Single-turn tool-calling evals on large frontier
> models were removed: they sat at native parity (foxfence transparent, zero
> repairs), so the numbers measured the model, not foxfence — and they predate
> the loop-breaker, which is the feature that actually helps on harder cases.

## Real models (34-case corpus, 2026-06)

Headline metric is the **valid tool-call rate** (a schema-valid call to the
right tool; or correctly no call). `repairs` is foxfence's bounded repair loop
firing.

| model (via) | direct | foxfence (auto) | repairs |
|---|---|---|---|
| **qwen2.5-7b-instruct** (OpenRouter) | 83% | **90%** ¹ | 5 |
| **llama-3.1-8b-instruct** (OpenRouter) | 86% | **100%** | 3 |

*(tool-call-case rate; the no-call cases sit at 100% for foxfence in every run —
it never introduced a false tool call, and on Llama it fixed a spurious direct
call, 80→100.)*

¹ On Qwen, the provider returned malformed native tool calls twice; foxfence's
runtime native→json-prompted downgrade fired and the repair loop recovered the
rest.

### Forcing the prompted shim (`--shim json-prompted`)

Driving a model that *has* native tools entirely through the prompted JSON
protocol + schema validation:

| model | direct (native) | foxfence (prompted) |
|---|---|---|
| qwen2.5-7b-instruct | 76% | **100%** |

The prompted shim **beats** Qwen's own native path — the prompted protocol with
schema validation is at least as reliable as native tool calling.

## Loop recovery (multi-turn `loop` cases)

The dimension where foxfence helps small/self-hosted models the most: a tool
call that keeps failing while the model re-fires it identically. The
`loop-broke` column scores whether the next turn escapes the loop.

| model (via) | direct | foxfence (`nudge`) |
|---|---|---|
| **hermes3** (Ollama, Q4) | 33% | **67%** |

With the default `nudge` action foxfence injects a corrective hint and lets the
model self-correct; `action: break` stops the loop deterministically (no extra
model call) for a hard cap. Regenerate with the `loop` cases in
[`cases/loop.json`](./cases/loop.json).

## What this validates

- **It improves small native models** (Qwen 83→90, Llama 86→100) via the
  runtime downgrade + repair loop, and the forced-shim run shows the prompted
  protocol can beat a model's own native tool calling.
- **It breaks stuck retry loops** (Hermes 3 33→67) — the failure mode small and
  self-hosted models hit that a native API won't fix for you.
- **The no-native-tools rescue case** — a model that emits no tool calls at all —
  is shown deterministically by the bundled simulator below (0% → ~86%).

**Caveat:** numbers are at provider-default temperature, so `direct` and
`foxfence` are independent samples — small wobble between them is sampling noise,
not signal. The valid tool-call rate is the stable metric. Regenerate to refresh.

## Bundled simulator (`bun run eval`, no endpoint)

A deterministic model with *no* native tool calling, for a self-contained CI
run: 0% called directly, ~86% behind the `json-prompted` shim. See the harness
in `eval/`.
