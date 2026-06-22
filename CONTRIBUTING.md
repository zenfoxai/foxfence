# Contributing to foxfence

Thanks for helping! foxfence is a deliberately small, auditable security
component (< 10 kLOC core target, minimal pinned dependencies). Contributions
are weighed against that: a change that grows the attack surface needs to earn
its keep.

## Development

```sh
bun install
bun test            # full suite
bun run typecheck   # tsc --noEmit
bun run eval        # tool-calling reliability table (bundled simulator)
bun run build       # single binary → dist/foxfence
```

- Every change ships with tests. Safety-critical code (the StreamSanitizer,
  the tool-policy matcher, the shim decoders) is tested adversarially — see the
  property-style tests that exercise every chunk boundary.
- Keep the core tiny: heavy detection belongs behind a `remote:` detector, not
  in-process. New runtime dependencies are a hard sell.
- Run `bun run typecheck` and `bun test` before opening a PR; CI runs both plus
  `bun audit`.

## Contributing a model profile

The [`profiles/`](./profiles/) directory is a **community cache of
observations** (§6.1) about how specific models behave behind an
OpenAI-compatible server — native-tool-calling reliability, chat-template
quirks, context windows. This is the most welcome kind of contribution.

A profile records what you have **verified on your own deployment**, not a
guess. To add one:

1. Run the eval against your model and endpoint and confirm the behavior:

   ```sh
   bun run eval --endpoint http://localhost:11434/v1 --model <your-model>
   ```

2. Add (or extend) a YAML file in `profiles/` — see
   [`profiles/README.md`](./profiles/README.md) for the schema. Keep claims
   conservative: prefer recording a concrete quirk (e.g. `no-system-role`) over
   a broad capability assertion, and note the model build/endpoint you tested.

3. Add a row to the bundled-profiles table in `profiles/README.md`.

Profiles drift across model versions and inference servers, so a PR that
narrows or corrects an existing profile based on fresh observation is just as
valuable as a new one.

## Reporting bugs and security issues

- Functional bugs: open an issue with a minimal `foxfence.yaml` + request.
- Security vulnerabilities: **do not** open a public issue — see
  [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the project's
[Apache 2.0 License](./LICENSE).
