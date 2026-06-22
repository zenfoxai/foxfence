# OpenClaw + foxfence + Ollama

The reference integration from the spec (§11.4): an OpenClaw-style agent talks
plain OpenAI to foxfence, and foxfence makes a local Ollama model reliable at
tool calling while enforcing a small safety policy.

```
OpenClaw ──OpenAI──▶ foxfence ──▶ Ollama (qwen2.5:7b-instruct)
            :4100      shim + secrets mask + tool policy
```

## Run it

```sh
export FOXFENCE_KEY=local-dev-key
docker compose -f examples/docker-compose.yml up --build

# pull the model into the ollama container (first run only)
docker compose -f examples/docker-compose.yml exec ollama ollama pull qwen2.5:7b-instruct

# verify the wire end to end
FOXFENCE_KEY=local-dev-key ./examples/smoke.sh
```

## Point your agent at foxfence

Any OpenAI-compatible client works. Set:

| setting | value |
|---|---|
| base URL | `http://localhost:4100/v1` |
| API key | `$FOXFENCE_KEY` |
| model | `qwen-tools` |

For example, with the OpenAI SDKs:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4100/v1", api_key="local-dev-key")
client.chat.completions.create(model="qwen-tools", messages=[...], tools=[...])
```

OpenClaw (and Aider/Cline/Hermes) take the same three settings in their config —
an OpenAI base URL, key, and model name. No agent-side changes are needed: tool
calling now works even though `qwen2.5:7b-instruct` is shimmed, and the policy in
[`foxfence.yaml`](./foxfence.yaml) is enforced on every tool call.

## What the policy does here

- `secrets: mask` — secrets in your prompts are replaced with placeholders
  before they reach Ollama and restored in the reply.
- `exec` calls containing `rm -rf` are blocked; `send_email` is blocked outright.
  A blocked call comes back as an in-band refusal the agent can recover from, not
  an HTTP error.
- Everything is recorded (metadata only) to `/var/log/foxfence/audit.jsonl`
  inside the container.

Tune all of this in [`foxfence.yaml`](./foxfence.yaml) — the config is the whole
behavior surface.
