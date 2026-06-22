# Packaging & distribution

foxfence ships as a single compiled binary. Releases are cut by pushing a
version tag (`vX.Y.Z`), which fans out to three channels:

## 1. GitHub Releases (primary) — `.github/workflows/release.yml`

Cross-compiles signed binaries for linux/macOS/Windows (x64 + arm64),
publishes `SHA256SUMS`, Sigstore keyless signatures (`*.sig`/`*.pem`), and a
rendered Homebrew formula (`foxfence.rb`). Verify a download:

```sh
sha256sum -c SHA256SUMS --ignore-missing
cosign verify-blob --certificate foxfence-linux-x64.pem \
  --signature foxfence-linux-x64.sig \
  --certificate-identity-regexp 'https://github.com/.*/foxfence/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  foxfence-linux-x64
```

## 2. Homebrew — `packaging/homebrew/foxfence.rb`

`brew install zenfoxai/tap/foxfence`. The release workflow renders the version
and per-arch SHA256s into a `foxfence.rb` release asset; copy that file into the
`zenfoxai/homebrew-tap` repo (one-time tap repo setup, then update the formula
per release — or automate it with a tap-update step + a PAT).

## 3. Docker (GHCR) — `.github/workflows/docker.yml`

`docker pull ghcr.io/zenfoxai/foxfence:latest` (multi-arch linux/amd64+arm64,
built from `examples/Dockerfile`). Run with your config mounted:

```sh
docker run -p 4100:4100 -v "$PWD/foxfence.yaml:/etc/foxfence/foxfence.yaml" \
  -e FOXFENCE_KEY=… ghcr.io/zenfoxai/foxfence:latest
```

## Cutting a release

```sh
# bump version in package.json, commit, then:
git tag vX.Y.Z && git push origin vX.Y.Z
```
