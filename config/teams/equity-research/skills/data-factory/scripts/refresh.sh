#!/usr/bin/env bash
# Thin shim — all logic lives in refresh.py.
# Keeping a .sh entry point so SKILL.md, schedule-job.sh, and any background
# job records that reference a shell script continue to work unchanged.
set -euo pipefail
exec python3 "$(dirname "$0")/refresh.py" "$@"
