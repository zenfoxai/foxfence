# Eval results

Tool-calling reliability **with and without foxfence** (§11.2). Regenerate with
`bun run eval` (bundled simulator) or
`bun run eval --endpoint <url> --model <name> --key <key>` against a real
OpenAI-compatible server. Add `--shim json-prompted` to force the capability
shim instead of the model's native tool calling.

## Real models (34-case corpus, 2026-06)

Headline metric is the **valid tool-call rate** (a schema-valid call to the
right tool; or correctly no call). `repairs` is foxfence's bounded repair loop
firing.

| model (via) | direct | foxfence (auto) | repairs |
|---|---|---|---|
| **qwen2.5-7b-instruct** (OpenRouter) | 83% | **90%** ¹ | 5 |
| **llama-3.1-8b-instruct** (OpenRouter) | 86% | **100%** | 3 |
| **gpt-4o** (OpenRouter) | 100% | 100% | 0 |
| **kimi-k2.6** (Fireworks) | 100% | 100% | 0 |
| **glm-5.2** (Fireworks) | 100% | 100% | 0 |
| **gpt-oss-120b** (Fireworks, reasoning) | 100% | 100% | 0 |

*(tool-call-case rate; the no-call cases sit at 100% for foxfence in every run —
it never introduced a false tool call, and on Llama it fixed a spurious direct
call, 80→100.)*

¹ On Qwen, the provider returned malformed native tool calls twice; foxfence's
runtime native→json-prompted downgrade fired and the repair loop recovered the
rest.

> **Methodology note — Cohere Command A.** An earlier version of this table
> reported `cohere/command-a` at 0% direct. That was **invalid**: the route we
> used (`cohere/command-a` via OpenRouter's default provider) returns
> `404 "No endpoints found that support tool use"` — the request *errors* rather
> than producing a tool call, so it can't be scored. Cohere Command A does
> support native tool calling (OpenAI-style `tools`; see
> [Cohere's docs](https://docs.cohere.com/docs/tool-use-overview)); the 0% was a
> provider-routing artifact, not a model result. We've removed the row rather
> than publish an unfair number. To evaluate Command A, point the harness at a
> tool-supporting endpoint (Cohere's own API / compatibility endpoint).

### Forcing the prompted shim (`--shim json-prompted`)

Driving a model that *has* native tools entirely through the prompted JSON
protocol + schema validation:

| model | direct (native) | foxfence (prompted) |
|---|---|---|
| qwen2.5-7b-instruct | 76% | **100%** |
| gpt-4o | 100% | 100% |

The prompted shim matches native on GPT-4o and **beats** Qwen's own native path —
the prompted protocol with validation is at least as reliable as native tool
calling.

## What this validates

- **It improves native models** (Qwen 83→90, Llama 86→100) via the runtime
  downgrade + repair loop, and the forced-shim runs show the prompted protocol
  can match or beat a model's native tool calling.
- **It is transparent on frontier models** (GPT-4o, Kimi K2.6, GLM-5.2,
  gpt-oss-120b all 100→100, 0 repairs) — principle #4: never degrade a model
  that already works. For these, foxfence's value is the *safety layer* (secrets,
  PII, tool-policy) plus repair-loop insurance, not raw tool-call capability.
- **The no-native-tools rescue case** — a model that emits no tool calls at all —
  is shown deterministically by the bundled simulator below (0% → ~86%).

**Caveat:** numbers are at provider-default temperature, so `direct` and
`foxfence` are independent samples — small exact-match-rate wobble between them
(e.g. gpt-oss foxfence 97% vs direct 94%) is sampling noise, not signal. The
valid tool-call rate is the stable metric. Regenerate to refresh.

## Bundled simulator (`bun run eval`, no endpoint)

A deterministic model with *no* native tool calling, for a self-contained CI
run: 0% called directly, ~86% behind the `json-prompted` shim. See the harness
in `eval/`.
