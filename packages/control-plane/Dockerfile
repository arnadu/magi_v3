# Build from repo root:
#   docker build -f packages/control-plane/Dockerfile -t magi-control .
# agent-runtime-worker is included in the image (copilot daemon); changes there also trigger this deploy.

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install workspace dependencies (needs all package.json files for npm workspaces).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/agent-config/package.json ./packages/agent-config/
COPY packages/control-plane/package.json ./packages/control-plane/
COPY packages/agent-runtime-worker/package.json ./packages/agent-runtime-worker/

RUN npm ci --ignore-scripts
COPY packages/agent-config ./packages/agent-config
COPY packages/agent-runtime-worker ./packages/agent-runtime-worker
COPY packages/control-plane ./packages/control-plane

# Build all packages (control-plane now depends on agent-runtime-worker).
RUN npx tsc -p packages/agent-config/tsconfig.json
RUN npx tsc -p packages/agent-runtime-worker/tsconfig.json
RUN npx tsc -p packages/control-plane/tsconfig.json

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# System dependencies for copilot subprocess isolation.
RUN apt-get update && apt-get install -y --no-install-recommends \
    acl \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# magi-shared group — copilot user belongs to this for sharedDir access.
RUN groupadd -g 60100 magi-shared

# Dedicated copilot OS user — singleton named user, same isolation model as
# execution-plane pool users but not drawn from the numbered pool.
RUN useradd -m -u 60010 -s /bin/bash -G magi-shared magi-copilot

# Non-root daemon user that owns the control-plane process.
RUN useradd -m -u 999 -s /bin/bash magi-operator

# magi-node wrapper — stable path used by sudoers rule so Node version upgrades
# don't require updating sudoers.
RUN printf '#!/bin/sh\nexec /usr/local/bin/node "$@"\n' > /usr/local/bin/magi-node && \
    chmod +x /usr/local/bin/magi-node

# sudoers: magi-operator may run magi-node as magi-copilot without a password.
RUN echo "magi-operator ALL=(magi-copilot) NOPASSWD: /usr/local/bin/magi-node" \
    > /etc/sudoers.d/magi && \
    chmod 440 /etc/sudoers.d/magi

# Copilot workdir (ephemeral; important state lives in MongoDB).
RUN mkdir -p /home/magi-copilot/workdir && \
    chown magi-copilot:magi-copilot /home/magi-copilot/workdir

# Copy built artifacts and production node_modules from builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/agent-config/dist ./packages/agent-config/dist
COPY --from=builder /app/packages/agent-config/package.json ./packages/agent-config/package.json
COPY --from=builder /app/packages/agent-runtime-worker/dist ./packages/agent-runtime-worker/dist
COPY --from=builder /app/packages/agent-runtime-worker/package.json ./packages/agent-runtime-worker/package.json
COPY --from=builder /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder /app/packages/control-plane/package.json ./packages/control-plane/package.json

# Copy the static UI.
COPY packages/control-plane/public ./packages/control-plane/public

# Include TypeScript source files so the copilot can read the codebase via Bash.
COPY packages/agent-config/src ./packages/agent-config/src
COPY packages/agent-runtime-worker/src ./packages/agent-runtime-worker/src
COPY packages/control-plane/src ./packages/control-plane/src

# Skills for copilot's sharedDir (same mechanism as execution plane).
COPY packages/skills ./packages/skills
COPY config ./config

# Run as the daemon user.
USER magi-operator

WORKDIR /app/packages/control-plane

EXPOSE 3000

CMD ["node", "dist/index.js"]

