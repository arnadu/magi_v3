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
# Environment variables:
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

echo "[setup-dev] MAGI V3 dev pool setup"
echo "  Pool size : ${POOL_SIZE}"
echo "  Home base : ${HOME_BASE}"
echo "  Missions  : ${MISSIONS}"
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
NODE_BIN="$(which node)"
POOL_LIST="$(seq -s, -f 'magi-w%.0f' 1 "${POOL_SIZE}")"
SUDOERS_FILE="/etc/sudoers.d/magi"

printf '%s ALL = (%s) NOPASSWD: %s\n' \
    "${ORCHESTRATOR}" "${POOL_LIST}" "${NODE_BIN}" > "${SUDOERS_FILE}"
chmod 440 "${SUDOERS_FILE}"
if visudo -cf "${SUDOERS_FILE}"; then
    echo "[setup-dev] Wrote sudoers rule: ${ORCHESTRATOR} → (${POOL_LIST}) NOPASSWD: ${NODE_BIN}"
else
    echo "[setup-dev] ERROR: invalid sudoers file — removing"
    rm -f "${SUDOERS_FILE}"
    exit 1
fi

echo ""
echo "[setup-dev] Done. Pool users: $(seq -s ', ' -f 'magi-w%.0f' 1 "${POOL_SIZE}")"
echo "            Re-run at any time — it is idempotent."
