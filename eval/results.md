# Eval results

Tool-calling reliability **with and without foxfence** (§11.2). Regenerate with
`bun run eval` (bundled simulated model) or `bun run eval --endpoint <url> --model <name>`
against a real OpenAI-compatible server.

Model under test: simulated weak model (no native tool calling)
Cases: 34

| mode | valid-call rate | exact-match rate | tool-call cases | no-call cases | repairs |
|---|---|---|---|---|---|
| direct | 15% | 15% | 0% (29) | 100% (5) | 0 |
| foxfence | 88% | 88% | 86% (29) | 100% (5) | 3 |

**Reading the table.** The bundled model has *no native tool calling*, so called
directly it produces 0% valid tool calls (it answers in text); it still scores
100% on the no-call cases because answering in text is the right move there.
Behind foxfence, the `json-prompted` shim parses those text replies into valid
OpenAI tool calls and the repair loop fixes the malformed ones — 86% of tool
cases recovered, no-call cases untouched, no false tool calls introduced. The
remaining ~14% are deliberately unrecoverable cases (the model emits no parseable
call even after a repair), so the harness can never report a fake 100%.

This is a *format-recovery* demonstration on a deterministic simulator. Numbers
for real models (Qwen, Llama, Mistral, …) come from running `bun run eval
--endpoint …` against them; contribute the resulting table here.
