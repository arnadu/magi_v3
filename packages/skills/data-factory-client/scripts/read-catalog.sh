#!/usr/bin/env bash
# read-catalog.sh - Print the data factory catalog.
#
# Usage:
#   bash read-catalog.sh [--json]
#
# Env:
#   SHARED_DIR  — mission shared directory (set by agent runtime)
#   SKILL_DIR   — this skill's directory (set by agent runtime)

set -euo pipefail

DF_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../data-factory/scripts" && pwd)"
FACTORY="${SHARED_DIR:?SHARED_DIR not set}/data-factory"

if [[ ! -d "${FACTORY}" ]]; then
    echo "Data factory not initialised. Run data-factory/scripts/refresh.py first." >&2
    exit 1
fi

if [[ "${1:-}" == "--json" ]]; then
    magi-python3 "${DF_SCRIPTS}/catalog.py" list "${FACTORY}" --json
else
    magi-python3 "${DF_SCRIPTS}/catalog.py" list "${FACTORY}"
fi
