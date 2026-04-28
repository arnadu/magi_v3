# Build from repo root:
#   docker build -f packages/control-plane/Dockerfile -t magi-control .

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install workspace dependencies (needs all package.json files for npm workspaces).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/agent-config/package.json ./packages/agent-config/
COPY packages/control-plane/package.json ./packages/control-plane/
# agent-runtime-worker is the only other npm workspace; copy its manifest so
# npm ci can satisfy the full workspace graph from the lock file.
COPY packages/agent-runtime-worker/package.json ./packages/agent-runtime-worker/

RUN npm ci --ignore-scripts
COPY packages/agent-config ./packages/agent-config
COPY packages/control-plane ./packages/control-plane

# Build agent-config first (control-plane depends on it).
RUN npx tsc -p packages/agent-config/tsconfig.json
RUN npx tsc -p packages/control-plane/tsconfig.json

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Copy built artifacts and production node_modules from builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/agent-config/dist ./packages/agent-config/dist
COPY --from=builder /app/packages/agent-config/package.json ./packages/agent-config/package.json
COPY --from=builder /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder /app/packages/control-plane/package.json ./packages/control-plane/package.json

# Copy the static UI.
COPY packages/control-plane/public ./packages/control-plane/public

# Non-root user for principle of least privilege.
RUN useradd -m -u 999 -s /bin/bash magi-control
USER magi-control

WORKDIR /app/packages/control-plane

EXPOSE 3000

CMD ["node", "dist/index.js"]
