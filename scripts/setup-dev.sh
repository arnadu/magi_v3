#!/usr/bin/env bash
# scripts/setup-dev.sh
#
# Provision the MAGI V3 development Linux user pool.
# Run once (or re-run — it is idempotent) before starting any mission.
#
# Creates:
#   - magi-w1 .. magi-w6   (pool workers; uid 60001..60006)
#   - magi-shared group    (gid 60100 — added to all pool users)
#   - /missions/           (shared mission folder root; setfacl default ACL)
#
# Requires: sudo, useradd, groupadd, setfacl (acl package)
#
# Usage:
#   sudo scripts/setup-dev.sh
#
#   With nvm (sudo strips PATH, so which node finds the wrong binary):
#   sudo env NODE_BIN=$(which node) scripts/setup-dev.sh
#
# Environment variables:
#   NODE_BIN         absolute path to the node binary to allow in sudoers
#                    (default: $(which node) — may be wrong under nvm+sudo)
#   MAGI_POOL_SIZE   number of pool users to create (default: 6)
#   MAGI_HOME_BASE   base for pool user homes (default: /home)
#   MAGI_MISSIONS    shared missions root (default: /missions)

set -euo pipefail

POOL_SIZE="${MAGI_POOL_SIZE:-6}"
HOME_BASE="${MAGI_HOME_BASE:-/home}"
MISSIONS="${MAGI_MISSIONS:-/missions}"

SHARED_GROUP="magi-shared"
SHARED_GID=60100
BASE_UID=60001

# Python version used by the system Python 3
PYTHON_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"

echo "[setup-dev] MAGI V3 dev pool setup"
echo "  Pool size  : ${POOL_SIZE}"
echo "  Home base  : ${HOME_BASE}"
echo "  Missions   : ${MISSIONS}"
echo "  Python     : python${PYTHON_VER}"
echo ""

# ---------------------------------------------------------------------------
# 0. Python packaging tools
#    Agents need pip and venv to install data-factory dependencies.
#    This also installs the data-factory requirements system-wide so that
#    pool users (magi-wN) can import yfinance, requests, etc. without having
#    to manage their own virtualenv.
# ---------------------------------------------------------------------------
echo "[setup-dev] Installing Python packaging tools ..."
apt-get install -y --no-install-recommends \
    "python${PYTHON_VER}-venv" \
    python3-pip \
    > /dev/null

# Locate requirements.txt relative to this script (scripts/ → repo root → skill)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_FACTORY_REQS="${SCRIPT_DIR}/../config/teams/equity-research/skills/data-factory/requirements.txt"

if [[ -f "${DATA_FACTORY_REQS}" ]]; then
    echo "[setup-dev] Installing data-factory Python requirements ..."
    pip3 install -q -r "${DATA_FACTORY_REQS}"
    echo "[setup-dev] Python requirements installed."
else
    echo "[setup-dev] Note: data-factory requirements.txt not found at ${DATA_FACTORY_REQS} — skipping"
fi
echo ""

# ---------------------------------------------------------------------------
# 1. Create magi-shared group
# ---------------------------------------------------------------------------
if getent group "${SHARED_GROUP}" > /dev/null 2>&1; then
    echo "[setup-dev] Group '${SHARED_GROUP}' already exists — skipping"
else
    groupadd --gid "${SHARED_GID}" "${SHARED_GROUP}"
    echo "[setup-dev] Created group '${SHARED_GROUP}' (gid ${SHARED_GID})"
fi

# ---------------------------------------------------------------------------
# 2. Create pool users magi-w1 .. magi-wN
# ---------------------------------------------------------------------------
for i in $(seq 1 "${POOL_SIZE}"); do
    USERNAME="magi-w${i}"
    UID_VAL=$((BASE_UID + i - 1))

    if id "${USERNAME}" > /dev/null 2>&1; then
        echo "[setup-dev] User '${USERNAME}' already exists — skipping"
    else
        useradd \
            --uid "${UID_VAL}" \
            --gid "${SHARED_GID}" \
            --home-dir "${HOME_BASE}/${USERNAME}" \
            --create-home \
            --shell /usr/sbin/nologin \
            --comment "MAGI V3 pool worker ${i}" \
            "${USERNAME}"
        echo "[setup-dev] Created user '${USERNAME}' (uid ${UID_VAL})"
    fi

    # Ensure the user is in the shared group even if it pre-existed.
    usermod -aG "${SHARED_GROUP}" "${USERNAME}" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# 3. Create /missions root with default ACL for the shared group
# ---------------------------------------------------------------------------
mkdir -p "${MISSIONS}"
chown root:"${SHARED_GROUP}" "${MISSIONS}"
chmod 2775 "${MISSIONS}"   # setgid so new subdirs inherit the group

# Default ACL: magi-shared group gets rwx on all new directories.
# Individual mission subdirs are setfacl'd at provision time.
if command -v setfacl > /dev/null 2>&1; then
    setfacl -d -m g:"${SHARED_GROUP}":rwx "${MISSIONS}"
    echo "[setup-dev] Set default ACL on '${MISSIONS}' for group '${SHARED_GROUP}'"
else
    echo "[setup-dev] WARNING: setfacl not found — install the 'acl' package for full ACL support"
fi

# ---------------------------------------------------------------------------
# 4. Grant orchestrator passwordless sudo to run node as any pool user
# ---------------------------------------------------------------------------
# The orchestrator forks tool-executor.js as magi-wN via:
#   sudo -u magi-wN <node> <path>/tool-executor.js
# Only the exact node binary is allowed — not ALL commands.
#
# Note: if nvm or a version manager is in use, re-run this script after
# upgrading Node to refresh the sudoers entry with the new binary path.

ORCHESTRATOR="${SUDO_USER:-$(logname 2>/dev/null || echo "${USER}")}"
# Allow the caller to override via NODE_BIN env var.
# With nvm, sudo strips PATH so "which node" finds the system binary, not the
# nvm-managed one.  Pass the correct path explicitly:
#   sudo env NODE_BIN=$(which node) scripts/setup-dev.sh
NODE_BIN="${NODE_BIN:-$(which node)}"
echo "[setup-dev] Node binary : ${NODE_BIN}"
if [[ ! -x "${NODE_BIN}" ]]; then
    echo "[setup-dev] ERROR: NODE_BIN '${NODE_BIN}' does not exist or is not executable."
    echo "            Re-run with: sudo env NODE_BIN=\$(which node) scripts/setup-dev.sh"
    exit 1
fi

# ---------------------------------------------------------------------------
# 4a. Create a stable wrapper at /usr/local/bin/magi-node
#     The sudoers rule always points to this fixed path.
#     The wrapper bakes in the actual node binary path discovered above, so
#     upgrading Node only requires re-running this script — the sudoers rule
#     itself never changes.
# ---------------------------------------------------------------------------
WRAPPER="/usr/local/bin/magi-node"
cat > "${WRAPPER}" << EOF
#!/bin/sh
# magi-node — stable wrapper for the MAGI tool-executor child process.
# Regenerated by scripts/setup-dev.sh; do not edit by hand.
exec ${NODE_BIN} "\$@"
EOF
chmod 755 "${WRAPPER}"
echo "[setup-dev] Wrote wrapper ${WRAPPER} → ${NODE_BIN}"

POOL_LIST="$(seq -s, -f 'magi-w%.0f' 1 "${POOL_SIZE}")"
SUDOERS_FILE="/etc/sudoers.d/magi"

{
    # Allow the orchestrator user to run the wrapper as any pool user without
    # a password.  The wrapper path is fixed; the real node path is inside it.
    printf '%s ALL = (%s) NOPASSWD: %s\n' "${ORCHESTRATOR}" "${POOL_LIST}" "${WRAPPER}"
    # Prevent sudo from prompting pool workers for a password.
    # Without this, sudo's default is to authenticate via PAM before checking
    # authorization — so a magi-wN user running "sudo anything" would produce
    # a password prompt on the daemon's terminal even though they have no
    # permitting rule.  !authenticate skips PAM; the command is still denied
    # by policy (no allowing rule exists), but it fails silently.
    printf 'Defaults:%%%s !authenticate\n' "${SHARED_GROUP}"
} > "${SUDOERS_FILE}"
chmod 440 "${SUDOERS_FILE}"
if visudo -cf "${SUDOERS_FILE}"; then
    echo "[setup-dev] Wrote sudoers rules in ${SUDOERS_FILE}"
else
    echo "[setup-dev] ERROR: invalid sudoers file — removing"
    rm -f "${SUDOERS_FILE}"
    exit 1
fi

echo ""
echo "[setup-dev] Done. Pool users: $(seq -s ', ' -f 'magi-w%.0f' 1 "${POOL_SIZE}")"
echo "            Re-run at any time — it is idempotent."
