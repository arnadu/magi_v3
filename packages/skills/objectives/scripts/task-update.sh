#!/usr/bin/env bash
# objectives/scripts/task-update.sh
#
# Append a task-update event to the objectives store (tasks.jsonl).
# Only the fields you pass are changed (last-write-wins on read); --note is
# appended to the task's notes. --effort is a relative per-turn weight used by
# cost attribution. This script ONLY appends — it never runs git.
#
# Usage:
#   task-update.sh --id TASK-x [--status S] [--assignee A] [--priority P]
#                  [--deadline D] [--budget USD] [--effort N] [--note "..."]
#
# Environment (provided by the Bash tool):
#   SHARED_DIR (required) — mission shared directory
#   AGENT_ID   (required) — your agent id (stamped as the event author)

set -euo pipefail
: "${SHARED_DIR:?SHARED_DIR not set}"
: "${AGENT_ID:?AGENT_ID not set}"

ID="" STATUS="" ASSIGNEE="" PRIORITY="" DEADLINE="" BUDGET="" EFFORT="" NOTE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id)       ID="$2";       shift 2;;
    --status)   STATUS="$2";   shift 2;;
    --assignee) ASSIGNEE="$2"; shift 2;;
    --priority) PRIORITY="$2"; shift 2;;
    --deadline) DEADLINE="$2"; shift 2;;
    --budget)   BUDGET="$2";   shift 2;;
    --effort)   EFFORT="$2";   shift 2;;
    --note)     NOTE="$2";     shift 2;;
    *) echo "task-update: unknown argument: $1" >&2; exit 1;;
  esac
done

[ -n "$ID" ] || { echo "task-update: --id is required" >&2; exit 1; }

STORE="$SHARED_DIR/objectives"
mkdir -p "$STORE"

ID="$ID" STATUS="$STATUS" ASSIGNEE="$ASSIGNEE" PRIORITY="$PRIORITY" \
DEADLINE="$DEADLINE" BUDGET="$BUDGET" EFFORT="$EFFORT" NOTE="$NOTE" \
BY="$AGENT_ID" STORE="$STORE" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const e = process.env;
const STATUSES = ["open","in-progress","blocked","completed","deferred","cancelled"];

if (e.STATUS && !STATUSES.includes(e.STATUS)) {
  console.error(`task-update: invalid --status "${e.STATUS}" (one of: ${STATUSES.join(", ")})`);
  process.exit(1);
}
const num = (v, name) => {
  const n = Number(v);
  if (Number.isNaN(n)) { console.error(`task-update: --${name} must be a number, got "${v}"`); process.exit(1); }
  return n;
};

const ev = { id: e.ID, at: new Date().toISOString(), by: e.BY };
if (e.STATUS)   ev.status = e.STATUS;
if (e.ASSIGNEE) ev.assignee = e.ASSIGNEE;
if (e.PRIORITY) ev.priority = e.PRIORITY;
if (e.DEADLINE) ev.deadline = e.DEADLINE;
if (e.BUDGET)   ev.budgetUsd = num(e.BUDGET, "budget");
if (e.EFFORT)   ev.effort = num(e.EFFORT, "effort");
if (e.NOTE)     ev.note = e.NOTE;

fs.appendFileSync(path.join(e.STORE, "tasks.jsonl"), JSON.stringify(ev) + "\n");
process.stdout.write(`task-update: ${ev.id} updated\n`);
NODE
