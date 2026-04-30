# Build stage — compile TypeScript from the repo root so workspace deps resolve.
FROM node:20-slim AS builder

WORKDIR /app

# Copy workspace manifests first for layer caching.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/agent-config/package.json ./packages/agent-config/
COPY packages/agent-runtime-worker/package.json ./packages/agent-runtime-worker/
# control-plane is the only other npm workspace; copy its manifest so
# npm ci can satisfy the full workspace graph from the lock file.
COPY packages/control-plane/package.json ./packages/control-plane/

RUN npm ci --ignore-scripts

# Copy source.
COPY packages/agent-config/ ./packages/agent-config/
COPY packages/agent-runtime-worker/ ./packages/agent-runtime-worker/

# Build agent-config first (dependency of agent-runtime-worker).
RUN npm run build -w packages/agent-config
RUN npm run build -w packages/agent-runtime-worker

# Runtime stage.
FROM node:20-slim AS runtime

# System dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    acl \
    sudo \
    git \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium for BrowseWeb (Playwright). Adds ~400 MB but required for
# JS-rendered financial sites used by gold-digest agents.
# Use npx playwright@<version> matching the resolved playwright-core version so
# Chromium's revision hash aligns. The full 'playwright' package is only needed
# here for the install CLI — runtime uses playwright-core.
RUN npx --yes playwright@1.58.2 install chromium --with-deps

# magi-shared group — all agent users belong to this group for sharedDir access.
RUN groupadd -g 60100 magi-shared

# Pool users for dev/test (uid 60001–60005). Production agents are created at
# daemon startup via ensureAgentUsers(), which derives the username from agent.id.
RUN for i in 1 2 3 4 5; do \
    useradd -m -u "6000$i" -s /bin/bash -G magi-shared "magi-w$i"; \
    done

# Non-root daemon user (uid 999). Owns the daemon process; never runs as root.
RUN useradd -m -u 999 -s /bin/bash magi-operator

# sudoers: magi-operator and pool users may run magi-node and magi-job without
# a password. The wrappers point to fixed paths — changing Node versions does
# not require updating sudoers rules.
RUN echo "Defaults:%magi-shared !authenticate" > /etc/sudoers.d/magi && \
    echo "magi-operator ALL=(ALL) NOPASSWD: /usr/local/bin/magi-node" >> /etc/sudoers.d/magi && \
    echo "magi-operator ALL=(ALL) NOPASSWD: /usr/local/bin/magi-job" >> /etc/sudoers.d/magi && \
    for i in 1 2 3 4 5; do \
      echo "magi-w$i ALL=(ALL) NOPASSWD: /usr/local/bin/magi-node" >> /etc/sudoers.d/magi; \
      echo "magi-w$i ALL=(ALL) NOPASSWD: /usr/local/bin/magi-job" >> /etc/sudoers.d/magi; \
    done && \
    chmod 440 /etc/sudoers.d/magi

# magi-node wrapper — exec's the real Node binary at a stable path.
# Avoids the nvm PATH problem (nvm not in sudo PATH).
RUN printf '#!/bin/sh\nexec /usr/local/bin/node "$@"\n' > /usr/local/bin/magi-node && \
    chmod +x /usr/local/bin/magi-node

# magi-job wrapper — runs an arbitrary script as the agent's OS user.
RUN printf '#!/bin/sh\nexec "$@"\n' > /usr/local/bin/magi-job && \
    chmod +x /usr/local/bin/magi-job

# magi-tool CLI wrapper.
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /app/packages/agent-runtime-worker/dist/cli-tool.js "$@"\n' \
    > /usr/local/bin/magi-tool && chmod +x /usr/local/bin/magi-tool

# Python venv for data factory scripts.
RUN python3 -m venv /opt/magi/venv && \
    chown -R root:magi-shared /opt/magi && \
    chmod -R g+rx /opt/magi

# magi-python3 wrapper — uses the venv interpreter; NOT a symlink (symlinks
# break venv path resolution; Python finds site-packages relative to argv[0]).
RUN printf '#!/bin/sh\nexec /opt/magi/venv/bin/python3 "$@"\n' \
    > /usr/local/bin/magi-python3 && chmod +x /usr/local/bin/magi-python3

WORKDIR /app

# Copy built app and config from builder.
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY config/ ./config/
# packages/skills/ is not in the builder stage (not compiled TypeScript) — copy direct.
COPY packages/skills/ ./packages/skills/

# Install data factory Python dependencies into the shared venv.
RUN /opt/magi/venv/bin/pip install --no-cache-dir \
    -r /app/packages/skills/data-factory/requirements.txt

# Volume mount point for the Fly.io workspace volume.
RUN mkdir -p /missions && chown magi-operator:magi-shared /missions

EXPOSE 4000 4001

# Run daemon as non-root magi-operator user.
USER magi-operator

CMD ["node", "--import", "./packages/agent-runtime-worker/dist/node-polyfill.js", "packages/agent-runtime-worker/dist/daemon.js"]
