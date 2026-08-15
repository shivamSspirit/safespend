# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG RUST_IMAGE=rust:1.96-slim-bookworm@sha256:e18a79fc84dfcfc3ab5ba72290398a644c135c97eaa881447fddc354ee4701a3

FROM ${NODE_IMAGE} AS dashboard-deps
WORKDIR /workspace/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dashboard-deps AS dashboard-builder
ENV SAFESPEND_DEPLOY_TARGET=render
COPY dashboard/ ./
RUN npm run build

FROM ${RUST_IMAGE} AS zeroclaw-builder
ARG ZEROCLAW_REF=f3023663a08f668dcec60c8d6d6db7777c86955a
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      g++ git pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
RUN git init \
    && git remote add origin https://github.com/zeroclaw-labs/zeroclaw.git \
    && git fetch --depth 1 origin "${ZEROCLAW_REF}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${ZEROCLAW_REF}"
RUN --mount=type=cache,id=zeroclaw-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=zeroclaw-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=zeroclaw-target-bookworm,target=/source/target,sharing=locked \
    cargo build --release --locked --no-default-features \
      --features agent-runtime,gateway,channel-telegram,plugins-wasm-cranelift \
    && cp target/release/zeroclaw /tmp/zeroclaw \
    && strip /tmp/zeroclaw

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libstdc++6 sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 safespend \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin safespend

WORKDIR /app
COPY --from=zeroclaw-builder /tmp/zeroclaw /usr/local/bin/zeroclaw
RUN /usr/local/bin/zeroclaw --version
COPY --from=dashboard-builder /workspace/dashboard/.next/standalone/ ./
COPY --from=dashboard-builder /workspace/dashboard/.next/static/ ./.next/static/
# Deploy only the reviewed, publisher-signed plugin artifacts. Rebuilding here
# would pair a source-derived WASM binary with release manifests signed for a
# different binary.
COPY release/plugins/ ./release/plugins/
COPY zeroclaw/sops/ ./zeroclaw/sops/
COPY deploy/render/start.mjs ./deploy/render/start.mjs
COPY deploy/render/payment-notifier.mjs ./deploy/render/payment-notifier.mjs

RUN mkdir -p /app/storage \
    && chown 10001:10001 /app/storage \
    && chmod 0700 /app/storage

ENV HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000 \
    SAFESPEND_DASHBOARD_STATE_DIR=/app/storage/dashboard \
    SAFESPEND_PAYMENT_CONFIG=/etc/secrets/devnet-payment-config.json \
    ZEROCLAW_CONFIG_DIR=/app/storage/zeroclaw \
    ZEROCLAW_GATEWAY_URL=http://127.0.0.1:42617

EXPOSE 3000
CMD ["/usr/local/bin/node", "/app/deploy/render/start.mjs"]
