# Security Policy

foxfence is a security component that sits on the wire between an agent and a
model, so its own attack surface is its first quality criterion (§2.5, §10).

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Email **security@zenfox.ai** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal `foxfence.yaml` + request is ideal),
- the foxfence version (`foxfence --version` or the release tag).

We aim to acknowledge within 3 business days and to ship a fix or mitigation
for confirmed high/critical issues within 30 days. We will credit reporters who
wish to be named once a fix is released. Please give us reasonable time to
remediate before any public disclosure.

## What counts as a vulnerability

Because foxfence is a safety/reliability proxy, we treat these as security
issues:

- **Secret/PII leakage** — a configured `secrets` detector failing to mask or
  redact, including across SSE chunk boundaries (see the StreamSanitizer
  invariants in `test/stream-sanitize.test.ts`).
- **Tool-policy bypass** — a tool call reaching the agent without the
  configured policy or argument validation being applied.
- **Egress escape** — foxfence making a network call to anything other than a
  configured upstream or a configured `remote:` detector URL.
- **Fail-open on detector error** when `on_detector_error: block` is set.
- **Resource exhaustion** reachable from a single request (e.g. a ReDoS in a
  policy pattern, unbounded buffering).

## What is explicitly *not* a sandbox

Tool-policy **argument-content matching is best-effort defense in depth**, not a
sandbox: a glob like `*rm -rf*` will not catch every variant (`rm -r -f`,
base64-wrapped payloads, etc.). Use `default: deny` allowlisting for anything
that truly matters. Reports that a clever argument evades a pattern match are
welcome as hardening suggestions but are expected behavior, not vulnerabilities.

## Security posture

- **Zero telemetry.** foxfence makes no network calls except to the upstreams
  and `remote:` detector URLs declared in your config.
- **Secrets via environment only**, never written to the audit log; mask &
  restore lives in memory for the lifetime of a request.
- **Pinned dependencies** and `bun audit` run in CI; the dependency surface is
  deliberately tiny.
- **Signed release binaries** (Sigstore keyless via GitHub OIDC) with published
  `SHA256SUMS` — verify before running. See [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Fail-closed is configurable and explicit** (`security.on_detector_error`).
