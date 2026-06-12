# foxfence

Model reliability & safety module for agents. An OpenAI-compatible proxy that
sits between any agent and any model, making cheap models more capable
(tool-calling shim) and safer (inline detectors). See
[SPEC-architecture.md](./SPEC-architecture.md) for the full design.

**Status: Phase 1 — transparent proxy.** The OpenAI SDK works unmodified
against foxfence, streaming included. Shim strategies, safety detectors, and
the repair loop land in subsequent phases.

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

## Development

```sh
bun test            # conformance + config suites
bun run typecheck   # tsc --noEmit
```
