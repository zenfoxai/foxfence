#!/usr/bin/env bash
# Smoke test for a running foxfence (§11.4). Exits non-zero on any failure.
#   FOXFENCE_KEY=local-dev-key ./examples/smoke.sh [base_url]
set -euo pipefail

BASE="${1:-http://localhost:4100}"
KEY="${FOXFENCE_KEY:-local-dev-key}"

echo "1/3  healthz"
curl -fsS "$BASE/healthz" >/dev/null && echo "     ok"

echo "2/3  /v1/models lists exposed models"
curl -fsS -H "authorization: Bearer $KEY" "$BASE/v1/models" | grep -q "qwen-tools" && echo "     ok"

echo "3/3  /v1/chat/completions round-trips"
curl -fsS -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"qwen-tools","messages":[{"role":"user","content":"Say hello in one word."}]}' \
  "$BASE/v1/chat/completions" | grep -q '"choices"' && echo "     ok"

echo "smoke test passed"
