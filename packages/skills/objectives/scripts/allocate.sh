#!/usr/bin/env bash
# objectives/scripts/allocate.sh
#
# Explicit cost-allocation timesheet (fallback). Use ONLY when your mental map
# flags unattributed cost — normally cost is attributed automatically from your
# task-update calls. This appends an allocation intent; the daemon turns it into
# attributed cost at the end of the turn. This script ONLY appends.
#
# Usage:
#   allocate.sh --key "TASK-1:60,overhead:40"
#
# The key is comma-separated target:weight pairs (relative weights). A target is
# a task id, an objective id, or the literal "overhead" (work not tied to any
# task/objective). Weights need not sum to 100.
#
# Environment (provided by the Bash tool):
#   SHARED_DIR (required) — mission shared directory
#   AGENT_ID   (required) — your agent id

set -euo pipefail
: "${SHARED_DIR:?SHARED_DIR not set}"
: "${AGENT_ID:?AGENT_ID not set}"

KEY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2;;
    *) echo "allocate: unknown argument: $1" >&2; exit 1;;
  esac
done

[ -n "$KEY" ] || { echo "allocate: --key is required (e.g. \"TASK-1:60,overhead:40\")" >&2; exit 1; }

STORE="$SHARED_DIR/objectives"
mkdir -p "$STORE"

KEY="$KEY" BY="$AGENT_ID" STORE="$STORE" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const e = process.env;

const key = {};
for (const pair of e.KEY.split(",")) {
  const idx = pair.indexOf(":");
  const t = idx >= 0 ? pair.slice(0, idx).trim() : "";
  const w = idx >= 0 ? Number(pair.slice(idx + 1).trim()) : Number.NaN;
  if (!t || Number.isNaN(w) || w <= 0) {
    console.error(`allocate: invalid pair "${pair}" — expected target:weight with weight > 0 (e.g. TASK-1:60)`);
    process.exit(1);
  }
  key[t] = (key[t] || 0) + w;
}
if (Object.keys(key).length === 0) {
  console.error("allocate: --key produced no targets");
  process.exit(1);
}

const ev = { by: e.BY, at: new Date().toISOString(), key };
fs.appendFileSync(path.join(e.STORE, "alloc.jsonl"), JSON.stringify(ev) + "\n");
process.stdout.write(`allocate: recorded ${JSON.stringify(key)}\n`);
NODE
