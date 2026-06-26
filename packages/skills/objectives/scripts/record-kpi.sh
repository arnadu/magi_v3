#!/usr/bin/env bash
# objectives/scripts/record-kpi.sh
#
# Append a KPI value event to the objectives store (kpis.jsonl). Use this for
# KPIs you own (the latest value wins on read). This script ONLY appends.
#
# Usage:
#   record-kpi.sh --kpi K4 --value "38" [--note "..."]
#
# A numeric --value is stored as a number; otherwise as text (e.g. met/partial).
#
# Environment (provided by the Bash tool):
#   SHARED_DIR (required) — mission shared directory
#   AGENT_ID   (required) — your agent id (stamped as the reporter)

set -euo pipefail
: "${SHARED_DIR:?SHARED_DIR not set}"
: "${AGENT_ID:?AGENT_ID not set}"

KPI="" VALUE="" NOTE="" HAS_VALUE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --kpi)   KPI="$2";              shift 2;;
    --value) VALUE="$2"; HAS_VALUE=1; shift 2;;
    --note)  NOTE="$2";             shift 2;;
    *) echo "record-kpi: unknown argument: $1" >&2; exit 1;;
  esac
done

[ -n "$KPI" ] || { echo "record-kpi: --kpi is required" >&2; exit 1; }
[ "$HAS_VALUE" -eq 1 ] || { echo "record-kpi: --value is required" >&2; exit 1; }

STORE="$SHARED_DIR/objectives"
mkdir -p "$STORE"

KPI="$KPI" VALUE="$VALUE" NOTE="$NOTE" BY="$AGENT_ID" STORE="$STORE" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const e = process.env;

// Coerce to number when the value is purely numeric; keep text otherwise.
const raw = e.VALUE;
const asNum = Number(raw);
const value = raw.trim() !== "" && !Number.isNaN(asNum) ? asNum : raw;

const ev = { kpi: e.KPI, value, by: e.BY, at: new Date().toISOString() };
if (e.NOTE) ev.note = e.NOTE;

fs.appendFileSync(path.join(e.STORE, "kpis.jsonl"), JSON.stringify(ev) + "\n");
process.stdout.write(`record-kpi: ${e.KPI} = ${value}\n`);
NODE
