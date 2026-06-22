# Build the foxfence single binary, then ship it on a slim base.
# Build context is the repo root: `docker build -f examples/Dockerfile .`

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
COPY bun.lock* ./
RUN bun install
COPY tsconfig.json ./
COPY src ./src
RUN bun build --compile --outfile foxfence src/main.ts

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 foxfence \
    && mkdir -p /var/log/foxfence \
    && chown foxfence /var/log/foxfence
COPY --from=build /app/foxfence /usr/local/bin/foxfence
COPY examples/openclaw/foxfence.yaml /etc/foxfence/foxfence.yaml
USER foxfence
EXPOSE 4100
ENTRYPOINT ["/usr/local/bin/foxfence", "--config", "/etc/foxfence/foxfence.yaml"]
