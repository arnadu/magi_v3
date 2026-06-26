#!/usr/bin/env bash
# objectives/scripts/task-add.sh
#
# Append a task-create event to the objectives store (tasks.jsonl).
# Prints the new task id. This script ONLY appends — it never runs git.
#
# Usage:
#   task-add.sh --title "..." [--id TASK-x] [--objective OBJ-y]
#               [--assignee A] [--status S] [--priority P] [--deadline D]
#               [--budget USD] [--note "..."]
#
# Defaults: --assignee = you (AGENT_ID); --status = open; --id auto-generated.
#
# Environment (provided by the Bash tool):
#   SHARED_DIR (required) — mission shared directory
#   AGENT_ID   (required) — your agent id (event author + default assignee)

set -euo pipefail
: "${SHARED_DIR:?SHARED_DIR not set}"
: "${AGENT_ID:?AGENT_ID not set}"

ID="" TITLE="" OBJECTIVE="" ASSIGNEE="" STATUS="" PRIORITY="" DEADLINE="" BUDGET="" NOTE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id)        ID="$2";        shift 2;;
    --title)     TITLE="$2";     shift 2;;
    --objective) OBJECTIVE="$2"; shift 2;;
    --assignee)  ASSIGNEE="$2";  shift 2;;
    --status)    STATUS="$2";    shift 2;;
    --priority)  PRIORITY="$2";  shift 2;;
    --deadline)  DEADLINE="$2";  shift 2;;
    --budget)    BUDGET="$2";    shift 2;;
    --note)      NOTE="$2";      shift 2;;
    *) echo "task-add: unknown argument: $1" >&2; exit 1;;
  esac
done

[ -n "$TITLE" ] || { echo "task-add: --title is required" >&2; exit 1; }

STORE="$SHARED_DIR/objectives"
mkdir -p "$STORE"

ID="$ID" TITLE="$TITLE" OBJECTIVE="$OBJECTIVE" ASSIGNEE="$ASSIGNEE" STATUS="$STATUS" \
PRIORITY="$PRIORITY" DEADLINE="$DEADLINE" BUDGET="$BUDGET" NOTE="$NOTE" \
BY="$AGENT_ID" STORE="$STORE" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const e = process.env;
const STATUSES = ["open","in-progress","blocked","completed","deferred","cancelled"];

const status = e.STATUS || "open";
if (!STATUSES.includes(status)) {
  console.error(`task-add: invalid --status "${status}" (one of: ${STATUSES.join(", ")})`);
  process.exit(1);
}
const id = e.ID || `TASK-${crypto.randomUUID().slice(0, 8)}`;

const ev = {
  id,
  at: new Date().toISOString(),
  by: e.BY,
  title: e.TITLE,
  objective: e.OBJECTIVE || null,
  assignee: e.ASSIGNEE || e.BY,
  status,
};
if (e.PRIORITY) ev.priority = e.PRIORITY;
if (e.DEADLINE) ev.deadline = e.DEADLINE;
if (e.BUDGET) {
  const n = Number(e.BUDGET);
  if (Number.isNaN(n)) { console.error(`task-add: --budget must be a number, got "${e.BUDGET}"`); process.exit(1); }
  ev.budgetUsd = n;
}
if (e.NOTE) ev.note = e.NOTE;

fs.appendFileSync(path.join(e.STORE, "tasks.jsonl"), JSON.stringify(ev) + "\n");
process.stdout.write(`${id}\n`);
NODE
