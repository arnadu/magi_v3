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
    echo "Data factory not initialised. Ask data-scientist to run refresh.sh." >&2
    exit 1
fi

if [[ "${1:-}" == "--json" ]]; then
    python3 "${DF_SCRIPTS}/catalog.py" list "${FACTORY}" --json
else
    python3 "${DF_SCRIPTS}/catalog.py" list "${FACTORY}"
fi
