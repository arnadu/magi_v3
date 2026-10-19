# Build stage — compile TypeScript from the repo root so workspace deps resolve.
# Base image pinned by digest (multi-arch index for node:22-slim) so a rebuild
# cannot silently pick up a different base; bump the digest deliberately, with
# the tag comment kept in step.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder

WORKDIR /app

# Copy workspace manifests first for layer caching.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/agent-config/package.json ./packages/agent-config/
COPY packages/agent-runtime-worker/package.json ./packages/agent-runtime-worker/
# control-plane is the only other npm workspace; copy its manifest so
# npm ci can satisfy the full workspace graph from the lock file.
COPY packages/control-plane/package.json ./packages/control-plane/

RUN npm ci --ignore-scripts

# --ignore-scripts above skips postinstall, so patch-package's own hook never
# runs; apply the pi-ai patch (patches/) explicitly.
COPY patches/ ./patches/
RUN npx patch-package

# Copy source.
COPY packages/agent-config/ ./packages/agent-config/
COPY packages/agent-runtime-worker/ ./packages/agent-runtime-worker/

# Build agent-config first (dependency of agent-runtime-worker).
RUN npm run build -w packages/agent-config
RUN npm run build -w packages/agent-runtime-worker

# Runtime stage.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

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
#
# Installed to a shared, world-readable path: the daemon runs as
# magi-operator, and a default install lands in /root/.cache (mode 700),
# where magi-operator's Playwright never looked — BrowseWeb could not
# launch on any mission machine until this was fixed (found 2026-10-18).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx --yes playwright@1.58.2 install chromium --with-deps && \
    chmod -R a+rX /opt/ms-playwright

# Managed Chromium policy: the browser may not open file://, chrome:// and
# other non-web schemes. Stagehand's agent can navigate to any URL the model
# picks, and a file:// page is read locally without passing the egress proxy
# (F-044). Root-owned and read-only to every agent; BrowseWeb refuses to start
# on Fly when this file is missing (browse-web.ts, chromiumPolicyProblem).
COPY packages/agent-runtime-worker/chromium-policy.json /etc/opt/chrome_for_testing/policies/managed/magi.json
RUN chmod 644 /etc/opt/chrome_for_testing/policies/managed/magi.json

# magi-shared group — all agent users belong to this group for sharedDir access.
RUN groupadd -g 60100 magi-shared

# Pool users for dev/test (uid 60001–60005). Production agents are created at
# daemon startup via ensureAgentUsers(), which derives the username from agent.id.
RUN for i in 1 2 3 4 5; do \
    useradd -m -u "6000$i" -s /bin/bash -G magi-shared "magi-w$i"; \
    done

# Non-root daemon user (uid 999). Owns the daemon process; never runs as root.
RUN useradd -m -u 999 -s /bin/bash magi-operator

# Mission-copilot OS user (ADR-0016; agent id "mission-copilot" maps to this
# username in production). Created at image build, not by the daemon at
# startup, so that /opt/magi-src below can be owned statically by root with
# this user's group — the daemon then never needs to (and cannot) change who
# may read the source the copilot trusts.
RUN useradd -m -u 60011 -s /bin/bash -G magi-shared mission-copilot

# Allow all users to access git repos under /missions and /app without "dubious
# ownership" errors. Pool users (uid 60001+) differ from magi-operator (uid 999)
# which owns the files written to the Fly Volume.
RUN git config --system safe.directory /missions && \
    git config --system safe.directory /app

# magi-create-user: root helper invoked via sudo by magi-operator to create
# per-agent OS users at daemon startup. Validates the username format;
# idempotent for a user it (or this image) created. An existing name is only
# accepted if it is a real agent-class user — uid >= 1000 and a member of
# magi-shared — so an agent id that collides with a system account (root,
# magi-operator, daemon, …) fails here instead of silently becoming a sudo
# target that the group-scoped grant below would then refuse at dispatch time.
# Does NOT touch sudoers (CR-01) — no agent identity ever needs its own sudo
# grant; sudo is only ever invoked by the trusted daemon to spawn a subprocess
# AS an agent. Membership in magi-shared is what makes the new user a valid
# sudo target of magi-operator's group-scoped grant.
RUN printf '%s\n' \
      '#!/bin/bash' \
      'set -e' \
      'if [[ ! "$1" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then' \
      '  echo "magi-create-user: invalid username" >&2; exit 1' \
      'fi' \
      'if id "$1" >/dev/null 2>&1; then' \
      '  if [[ "$(id -u "$1")" -lt 1000 ]]; then' \
      '    echo "magi-create-user: $1 is a system account, not an agent user" >&2; exit 1' \
      '  fi' \
      '  if ! id -nG "$1" | tr " " "\n" | grep -qx magi-shared; then' \
      '    echo "magi-create-user: $1 exists but is not in magi-shared" >&2; exit 1' \
      '  fi' \
      '  exit 0' \
      'fi' \
      'useradd -m -s /bin/bash -G magi-shared "$1"' \
      > /usr/local/bin/magi-create-user && chmod 755 /usr/local/bin/magi-create-user

# sudoers: ONLY magi-operator (the daemon) may invoke sudo, and only to become
# a member of magi-shared (every pool/per-agent user, never root or any other
# system identity) — CR-01's fix. Previously every pool/per-agent user held
# its own "ALL=(ALL)" grant (any target user, including root) directly, so an
# agent's own Bash tool could `sudo -u root magi-job /bin/bash` for a trivial
# container-root escalation; no agent identity has ever had a legitimate
# reason to invoke sudo itself (only the daemon does, to spawn each agent's
# isolated subprocess or create its OS user — daemon.ts/tools.ts). The
# `(%magi-shared)` group-based runas target means a newly created per-agent
# user is automatically a valid target the moment magi-create-user adds it to
# the group, with no sudoers file edit at runtime.
# env_keep for magi-job: sudo's default env_reset strips all custom vars before
# exec. A background job inherits exactly two: the Tool API address and its own
# scoped token. Data-provider keys are deliberately absent — jobs reach
# FRED/FMP/NewsAPI through the daemon's data-* tools (CR-04), never through a
# raw key in their environment, so sudo must not be able to pass one through
# even if the daemon's env ever leaked into a spawn.
RUN echo "Defaults!/usr/local/bin/magi-job env_keep += \"MAGI_TOOL_URL MAGI_TOOL_TOKEN\"" > /etc/sudoers.d/magi && \
    echo "magi-operator ALL=(root) NOPASSWD: /usr/local/bin/magi-create-user" >> /etc/sudoers.d/magi && \
    echo "magi-operator ALL=(%magi-shared) NOPASSWD: /usr/local/bin/magi-node" >> /etc/sudoers.d/magi && \
    echo "magi-operator ALL=(%magi-shared) NOPASSWD: /usr/local/bin/magi-job" >> /etc/sudoers.d/magi && \
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
# The runtime needs dist/ (and node_modules/) readable by every agent user:
# magi-tool and the isolated tool-executor run *as the agent*. The TypeScript
# source and the tests do not belong in the image at all — the only copy an
# agent may read is the copilot-gated one under /opt/magi-src below.
RUN rm -rf /app/packages/agent-config/src /app/packages/agent-config/tests \
           /app/packages/agent-runtime-worker/src /app/packages/agent-runtime-worker/tests

# /opt/magi-src/ — read-only platform source + spec for the mission copilot
# (ADR-0016) to diagnose platform bugs and check the real tool/skill catalog
# before granting one. Owned by root, group mission-copilot, mode 750: the
# copilot's own OS user (created above) can read it, every other agent's Bash
# gets EACCES (Bash has no software path check, A-002, so this mode is the
# whole boundary), and no runtime process — the daemon included — can modify
# or re-grant it, so what the copilot reads and trusts is fixed at build time.
# The daemon only verifies readability at startup (daemon-boot/agent-identity.ts).
# dist/ under /app is necessarily agent-readable (see above); the gate here is
# the human-readable source and the spec, which is what the copilot is told
# to consult.
RUN mkdir -p /opt/magi-src
COPY --from=builder --chown=root:mission-copilot /app/packages/agent-runtime-worker/src/ /opt/magi-src/packages/agent-runtime-worker/src/
COPY --from=builder --chown=root:mission-copilot /app/packages/agent-config/src/ /opt/magi-src/packages/agent-config/src/
COPY --chown=root:mission-copilot MAGI_V3_SPEC.md /opt/magi-src/MAGI_V3_SPEC.md
RUN chown root:mission-copilot /opt/magi-src && chmod -R 750 /opt/magi-src

# Install data factory Python dependencies into the shared venv.
RUN /opt/magi/venv/bin/pip install --no-cache-dir \
    -r /app/packages/skills/data-factory/requirements.txt

# Volume mount point for the Fly.io workspace volume.
RUN mkdir -p /missions && chown magi-operator:magi-shared /missions

EXPOSE 4000 4001

# Run daemon as non-root magi-operator user.
USER magi-operator

CMD ["node", "--import", "./packages/agent-runtime-worker/dist/node-polyfill.js", "packages/agent-runtime-worker/dist/daemon.js"]
