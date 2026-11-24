# Build from repo root:
#   docker build -f packages/control-plane/Dockerfile -t magi-control .
# agent-runtime-worker is included in the image (copilot daemon); changes there also trigger this deploy.

# ── Stage 1: builder ──────────────────────────────────────────────────────────
# Base image pinned by digest (multi-arch index for node:22-slim); bump
# deliberately, keeping the tag comment in step.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS builder

WORKDIR /app

# Install workspace dependencies (needs all package.json files for npm workspaces).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/agent-config/package.json ./packages/agent-config/
COPY packages/control-plane/package.json ./packages/control-plane/
COPY packages/agent-runtime-worker/package.json ./packages/agent-runtime-worker/
# Cockpit is a workspace member: npm ci needs its package.json to resolve the
# lockfile. Its Vite build output is NOT built in this image (avoids pulling
# Vite/esbuild into the build, which also conflicts with --ignore-scripts) —
# instead packages/control-plane/public/ is built by CI (see
# deploy-control-plane.yml "Build cockpit" step) BEFORE `docker build` runs, and
# copied in below via the public/ copy. It is gitignored, not committed — the
# committed source of truth is packages/cockpit/src.
COPY packages/cockpit/package.json ./packages/cockpit/

RUN npm ci --ignore-scripts

# --ignore-scripts above skips postinstall, so patch-package's own hook never
# runs; apply the pi-ai patch (patches/) explicitly. Needed here too — this
# image bundles agent-runtime-worker (the copilot daemon), a pi-ai consumer.
COPY patches/ ./patches/
RUN npx patch-package

COPY packages/agent-config ./packages/agent-config
COPY packages/agent-runtime-worker ./packages/agent-runtime-worker
COPY packages/control-plane ./packages/control-plane

# Build all packages (control-plane now depends on agent-runtime-worker).
RUN npx tsc -p packages/agent-config/tsconfig.json
RUN npx tsc -p packages/agent-runtime-worker/tsconfig.json
RUN npx tsc -p packages/control-plane/tsconfig.json

# Only production dependencies reach the runtime image: the build and test tools (TypeScript,
# vitest, esbuild, vite) never run there, and carried most of the image scan's findings
# (2026-11-23: 30 of 45, all 3 critical).
RUN npm prune --omit=dev --ignore-scripts

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime

# npm 11 in place of the base image's npm 10.9.x, whose bundled packages carried every
# remaining image-scan finding (2026-11-23: brace-expansion, picomatch, sigstore, pacote,
# ip-address; npm 11.21.2 has none). Agents and MAGI DEV's advisory triage run npm.
RUN npm install -g npm@11.21.2 && npm cache clean --force

WORKDIR /app

# System dependencies for copilot subprocess isolation.
# `apt-get upgrade` keeps the base image's own packages patched at every build (2026-11-23: apt
# 2.6.1, CVE-2026-109518, fixed in 2.6.2).
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    acl \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# magi-shared group — copilot user belongs to this for sharedDir access.
RUN groupadd -g 60100 magi-shared

# Dedicated copilot OS user — singleton named user, same isolation model as
# execution-plane pool users but not drawn from the numbered pool.
RUN useradd -m -u 60010 -s /bin/bash -G magi-shared magi-copilot

# Non-root daemon user that owns the control-plane process.
# Member of magi-shared so it can write to the copilot workdir for skill provisioning.
RUN useradd -m -u 999 -s /bin/bash -G magi-shared magi-operator

# magi-node wrapper — stable path used by sudoers rule so Node version upgrades
# don't require updating sudoers.
RUN printf '#!/bin/sh\nexec /usr/local/bin/node "$@"\n' > /usr/local/bin/magi-node && \
    chmod +x /usr/local/bin/magi-node

# sudoers: magi-operator may run magi-node as magi-copilot without a password.
RUN echo "magi-operator ALL=(magi-copilot) NOPASSWD: /usr/local/bin/magi-node" \
    > /etc/sudoers.d/magi && \
    chmod 440 /etc/sudoers.d/magi

# Copilot workdir — owned by magi-copilot, group magi-shared so magi-operator
# can create subdirectories (e.g. skills/_platform) at runtime.
RUN mkdir -p /home/magi-copilot/workdir && \
    chown magi-copilot:magi-shared /home/magi-copilot/workdir && \
    chmod 2775 /home/magi-copilot/workdir

# Copy built artifacts and production node_modules from builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/agent-config/dist ./packages/agent-config/dist
COPY --from=builder /app/packages/agent-config/package.json ./packages/agent-config/package.json
COPY --from=builder /app/packages/agent-runtime-worker/dist ./packages/agent-runtime-worker/dist
COPY --from=builder /app/packages/agent-runtime-worker/package.json ./packages/agent-runtime-worker/package.json
# Platform prompts (src/prompts.ts) — read at module load, so the control plane
# cannot start without them: it imports the worker package.
COPY --from=builder /app/packages/agent-runtime-worker/prompts ./packages/agent-runtime-worker/prompts
COPY --from=builder /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder /app/packages/control-plane/package.json ./packages/control-plane/package.json

# Copy the static UI.
COPY packages/control-plane/public ./packages/control-plane/public

# TypeScript source so the copilot can read the codebase via Bash (as
# magi-copilot). Group magi-shared, no world bits: readable by the two process
# identities that need it (magi-operator, magi-copilot) and by nothing else
# that might ever be added to this image.
COPY --chown=root:magi-shared packages/agent-config/src ./packages/agent-config/src
COPY --chown=root:magi-shared packages/agent-runtime-worker/src ./packages/agent-runtime-worker/src
COPY --chown=root:magi-shared packages/control-plane/src ./packages/control-plane/src
RUN chmod -R o-rwx ./packages/agent-config/src ./packages/agent-runtime-worker/src ./packages/control-plane/src

# The platform spec — documents architecture and the tool catalog end to end
# (ADR-0016 Track 3). Without this the copilot's only way to answer "what
# tools does a mission agent get" was reverse-engineering intent from raw
# source, the same gap the execution-plane copilot's /opt/magi-src/ bundling
# (ADR-0016 Phase 2a) exists to avoid on the other side of the architecture.
COPY MAGI_V3_SPEC.md ./MAGI_V3_SPEC.md

# Skills for copilot's sharedDir (same mechanism as execution plane).
COPY packages/skills ./packages/skills
COPY config ./config

# Run as the daemon user.
USER magi-operator

WORKDIR /app/packages/control-plane

EXPOSE 3000

CMD ["node", "dist/index.js"]

