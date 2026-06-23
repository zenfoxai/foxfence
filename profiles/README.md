# Model profiles

A **community cache of observations** (§6.1) about how specific models behave
behind an OpenAI-compatible server — things the auto probe can't see cheaply:
native-tool-calling reliability, chat-template quirks, context window.

A profile is *optional*. With `shim: auto` foxfence probes and adapts on its
own; a profile lets you **pin** behavior for deterministic production, or
record a **quirk** that changes how the shim encodes requests.

## Using one

Reference a profile by id from a model route (the id is matched against the
files in this directory, or `profiles_dir` in your config):

```yaml
models:
  - expose: gemma
    upstream: ollama
    model: gemma-2-9b-it
    profile: gemma-2          # or an inline object instead of an id
```

## Format

```yaml
- id: my-model               # required, unique
  capabilities:              # optional — overrides the probe (no probing then)
    toolCalling: native      # native | weak | none
    parallelToolCalls: false
    jsonMode: none           # native | prompted | none
  pinStrategy: json-prompted # optional — native | json-prompted | constrained
  contextWindow: 32768       # optional
  chatTemplateQuirks:        # optional; acted on: "no-system-role"
    - no-system-role
```

Precedence when selecting a strategy: an explicit route `shim:` wins, then
`pinStrategy`, then declared `capabilities`, then the probe.

## Bundled profiles

| id | what it records |
|---|---|
| `qwen2.5-instruct` | native tool calling (verified via OpenRouter) |
| `llama-3.1-instruct`, `llama-3.3-instruct` | native tool calling (3.1 verified via OpenRouter) |
| `mistral-small-3.2`, `mistral-small-3.1`, `ministral-8b` | native tool calling, 128K context (3.2 + Ministral 8B verified via OpenRouter) |
| `command-a-plus`, `command-a` | Cohere Command A — 256K context; native tool calling per Cohere's docs, but left on `shim: auto` because some proxy routings don't expose tool use for it |
| `gemma-2`, `gemma-3` | `no-system-role` chat-template quirk |

## Contributing

These are *observations*, not guarantees — they can drift across model
versions and inference servers. Verify against your own deployment (run
`bun run eval --endpoint … --model …`), keep claims to what you've seen, and
prefer recording a concrete quirk over a broad capability assertion. The
bundled set is deliberately small and conservative.
