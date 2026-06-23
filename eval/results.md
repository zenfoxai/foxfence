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

## Multi-turn reliability — loop recovery & state drift

The dimension where foxfence is meant to help small/self-hosted models:

- **`loop` cases** ([`cases/loop.json`](./cases/loop.json)) — a tool call that
  keeps failing while the model re-fires it identically. Scored by `loop-broke`.
- **`drift` cases** ([`cases/drift.json`](./cases/drift.json)) — a long
  tool-heavy chat where a system constraint ("never call X") gets forgotten.
  Scored by `drift-resist`.

**The mechanisms are verified deterministically** in `test/loop.test.ts` and
`test/reground.test.ts` — the loop nudge and the re-grounding reminder are
provably injected at the configured thresholds, with `break`/disable paths.
That is the real validation.

**Real-model numbers are small-sample (3 loop / 2 drift cases) — directional:**

| model (local, Ollama) | loop-broke (3) | drift-resist (2) |
|---|---|---|
| **qwen2.5-7b-instruct** | 67% → **100%** (`nudge`) | 100% → 100% (no headroom) |
| hermes3 (Q4) | 33–67% → 33–67% (noisy) | 50% → 50% |

On **qwen2.5-7b-instruct** the loop-breaker shows a clean lift — it self-recovers
from 2 of 3 loops, and the `nudge` carries the third to **100%**. The `break`
action makes it deterministic on any model (the loop stops without another call).

The **drift** cases show no lift on either model — not because re-grounding
fails to fire (the tests prove it does) but because neither model actually
drifts on these two cases at 6 tool results (qwen2.5 already resists at 100%,
so there's nothing to recover). A real-model drift demonstration needs harder /
longer cases or a genuinely drift-prone model; the mechanism is validated by
`test/reground.test.ts` meanwhile.

Both transforms are **additive and low-risk** — they only add a hint / re-assert
the prompt, so they never degrade a model that doesn't need them. Larger corpora
and weaker-model runs are welcome contributions.

## What this validates

- **It improves small native models** (Qwen 83→90, Llama 86→100) via the
  runtime downgrade + repair loop, and the forced-shim run shows the prompted
  protocol can beat a model's own native tool calling.
- **It addresses multi-turn failure modes** native APIs leave to you — stuck
  retry loops (loop-breaker, qwen2.5-7b 67→100) and forgotten system constraints
  (re-grounding), verified deterministically by the test suite. The `break`
  action is a hard, deterministic loop stop; real-model lift depends on the model
  and corpus size (small-n; see the table above).
- **The no-native-tools rescue case** — a model that emits no tool calls at all —
  is shown deterministically by the bundled simulator below (0% → ~86%).

**Caveat:** numbers are at provider-default temperature, so `direct` and
`foxfence` are independent samples — small wobble between them is sampling noise,
not signal. The valid tool-call rate is the stable metric. Regenerate to refresh.

## Bundled simulator (`bun run eval`, no endpoint)

A deterministic model with *no* native tool calling, for a self-contained CI
run: 0% called directly, ~86% behind the `json-prompted` shim. See the harness
in `eval/`.
