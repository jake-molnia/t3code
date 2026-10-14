# syntax=docker/dockerfile:1.7
FROM golang:1.27.1-trixie@sha256:9baa6b4187bbb98d240372a8a235ac0bb6b5ddd52bba1431dc2f7c0705862728 AS go-toolchain

FROM node:26.9.0-trixie-slim@sha256:65f816afd401c1c4de3293acc46dce115398152af4bdcd73c103b096988922d7 AS worker-build
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts pnpm@11.10.0
WORKDIR /src/t3
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc --noEmit -p apps/server/tsconfig.json && pnpm --filter t3 build:bundle
FROM worker-build AS worker-package
# Deploy changes pnpm workspace state; keep it separate from the web build.
# pnpm preserves the locked, patched native dependency closure in a portable package.
RUN pnpm --filter t3 deploy --prod --legacy /out/worker
COPY LICENSE /out/worker/LICENSE

FROM node:26.9.0-trixie-slim@sha256:65f816afd401c1c4de3293acc46dce115398152af4bdcd73c103b096988922d7 AS harnesses
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY images/t3/harnesses/package*.json /opt/harnesses/
RUN npm ci --prefix /opt/harnesses --omit=dev --no-audit --no-fund
COPY images/t3/providers.lock.json /opt/providers.lock.json
COPY images/t3/install-native.py /tmp/install-native.py
RUN python3 /tmp/install-native.py /opt/providers.lock.json /opt/native

FROM --platform=$BUILDPLATFORM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS desktop-tools
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY images/t3/install-code-server.sh /tmp/
RUN sh /tmp/install-code-server.sh "${TARGETARCH}" /opt/code-server

FROM ghcr.io/jake-molnia/agent-runtime-sandbox@sha256:accc2fdce07aa859dc86a59549e0d12baea04aeced200533475281e7f0347d84 AS t3-worker
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates git git-lfs openssh-client python3 python3-venv ripgrep tini lsof procps chromium make g++ libffi8 libssl3t64 libbz2-1.0 libuuid1 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts pnpm@11.10.0 \
    && mkdir -p /workspace && chown node:node /workspace
COPY --from=desktop-tools /opt/code-server /opt/code-server
COPY --from=go-toolchain /usr/local/go /usr/local/go
COPY --from=worker-package /out/worker /opt/t3
COPY --from=harnesses /opt/harnesses /opt/harnesses
COPY --from=harnesses /opt/native/bin /opt/native/bin
COPY --from=harnesses /opt/native/az/opt/az /opt/az
COPY --from=harnesses /opt/native/az/usr/bin/az /usr/bin/az
COPY --from=harnesses /opt/native/extensions /opt/azure/extensions
COPY --from=harnesses /opt/providers.lock.json /opt/t3/providers.lock.json
RUN ln -sfn /usr/local/bin/opencode /usr/local/bin/opencode2 \
    && ln -s /opt/code-server/bin/code-server /usr/local/bin/code-server \
    && ln -s /opt/t3/dist/bin.mjs /usr/local/bin/t3 \
    && chmod +x /opt/t3/dist/bin.mjs
ENV PATH=/opt/t3/bin:/opt/markitdown/bin:/usr/local/go/bin:/opt/harnesses/node_modules/.bin:/opt/native/bin:$PATH \
    AZURE_EXTENSION_DIR=/opt/azure/extensions AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no AZURE_CORE_COLLECT_TELEMETRY=no \
    T3_WORKSPACE_ROOT=/workspace T3_WORKER_STATE_DIR=/workspace/.t3-worker \
    T3_WORKER_PORT=8083 T3_BROWSER_EXECUTABLE=/usr/bin/chromium \
    T3CODE_SERVER_BROWSER_SANDBOX=0 SANDBOX_CHROMIUM_SANDBOX=disabled \
    T3_ACP_MCP_NODE=/usr/local/bin/node T3_ACP_MCP_ENTRYPOINT=/opt/t3/dist/bin.mjs \
    HOME=/workspace/home CODEX_HOME=/workspace/home/.codex \
    DISABLE_AUTOUPDATER=1 MUSE_NO_AUTO_UPDATE=1
COPY --chmod=755 images/t3/entrypoint.sh /usr/local/bin/t3-worker-entrypoint
COPY --chmod=755 images/t3/git-credential.py /usr/local/bin/t3-git-credential
COPY --chmod=755 images/t3/gh-wrapper.py /opt/t3/bin/gh
COPY --chmod=755 images/t3/configure-git.sh /usr/local/bin/t3-configure-git
COPY images/t3/probe-antigravity.py images/t3/verify-image.mjs images/t3/smoke-worker.py images/t3/smoke-session.py images/t3/test_git_credential.py images/t3/git-credential.py images/t3/configure-git.sh images/t3/gh-wrapper.py images/t3/test_gh_wrapper.py /opt/t3/
USER 0:0
WORKDIR /workspace
RUN mkdir -p "$HOME" "$CODEX_HOME" "$T3_WORKER_STATE_DIR" \
    && python3 /opt/t3/test_git_credential.py && python3 /opt/t3/test_gh_wrapper.py \
    && node /opt/t3/verify-image.mjs && python3 /opt/t3/smoke-worker.py /opt/t3
EXPOSE 8083
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/t3-worker-entrypoint"]


FROM worker-build AS web-build
RUN pnpm exec tsc --noEmit -p apps/web/tsconfig.json && pnpm --filter @t3tools/web build

FROM node:26.9.0-trixie-slim@sha256:65f816afd401c1c4de3293acc46dce115398152af4bdcd73c103b096988922d7 AS t3-web
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data && chown node:node /data
COPY --from=worker-package /out/worker /opt/t3
COPY --from=web-build /src/t3/apps/web/dist /opt/t3/dist/client
COPY images/t3/smoke-web.py images/t3/migrate-execution-profiles.py images/t3/test_migrate_execution_profiles.py /opt/t3/
RUN PYTHONDONTWRITEBYTECODE=1 python3 /opt/t3/test_migrate_execution_profiles.py \
    && rm /opt/t3/test_migrate_execution_profiles.py
ENV HOME=/data T3CODE_HOME=/data/t3
USER 1000:1000
WORKDIR /data
RUN python3 /opt/t3/smoke-web.py /opt/t3
EXPOSE 3773
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "/opt/t3/dist/bin.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3773", "--no-browser", "--base-dir", "/data/t3"]

