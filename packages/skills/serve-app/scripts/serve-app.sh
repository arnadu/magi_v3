#!/usr/bin/env bash
# serve-app/scripts/serve-app.sh — declare and control your interactive apps (ADR-0037).
#
#   serve-app.sh declare <name> --kind jupyter|gradio|site --path <abs path> \
#                [--handlers <abs .py>] [--description "<text>"]
#   serve-app.sh start|stop|remove <name>
#   serve-app.sh status [<name>]          # one app, or all of the mission's apps
#
# Writes a request to $SHARED_DIR/apps/requests/, which the daemon reads every
# 5 seconds and attributes to you (the file's owner). Waits for the daemon's
# answer, then, for declare and start, until the app runs or fails.
#
# Environment: SHARED_DIR (required); WORKDIR (to show your app's log on failure).

set -euo pipefail

die() { echo "serve-app: $*" >&2; exit 1; }
[[ -n "${SHARED_DIR:-}" ]] || die "SHARED_DIR is not set"
APPS="$SHARED_DIR/apps"

show_status() {
    python3 - "$APPS/status" "${1:-}" <<'PY'
import json, os, sys
d, name = sys.argv[1], sys.argv[2]
files = [f"{name}.json"] if name else sorted(f for f in os.listdir(d) if f.endswith(".json")) if os.path.isdir(d) else []
if not files:
    print("No apps." if not name else f"No app named {name}.")
for f in files:
    p = os.path.join(d, f)
    if not os.path.exists(p):
        print(f"No app named {name}."); continue
    a = json.load(open(p))
    line = f"{a['name']} ({a['kind']}, owner {a['owner']}): {a['status']}"
    if a.get("port"): line += f", port {a['port']}"
    if a.get("rssMb") is not None: line += f", {a['rssMb']} MB"
    print(line)
    if a.get("lastError"): print(f"  last error: {a['lastError']}")
    if a.get("description"): print(f"  {a['description']}")
PY
}

ACTION="${1:-}"; shift || true
case "$ACTION" in
    status) show_status "${1:-}"; exit 0 ;;
    declare|start|stop|remove) ;;
    *) die "usage: serve-app.sh declare <name> --kind K --path P [--handlers H] [--description D] | start|stop|remove <name> | status [<name>]" ;;
esac
NAME="${1:-}"; shift || true
[[ "$NAME" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die "the name must be lowercase letters, digits and dashes, starting with a letter (at most 40)"

KIND=""; APP_PATH=""; HANDLERS=""; DESCRIPTION=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --kind) KIND="$2"; shift 2 ;;
        --path) APP_PATH="$2"; shift 2 ;;
        --handlers) HANDLERS="$2"; shift 2 ;;
        --description) DESCRIPTION="$2"; shift 2 ;;
        *) die "unknown flag: $1" ;;
    esac
done
if [[ "$ACTION" == declare ]]; then
    [[ -n "$KIND" && -n "$APP_PATH" ]] || die "declare needs --kind and --path"
    APP_PATH="$(realpath -e "$APP_PATH")" || die "no such path: $APP_PATH"
    [[ -z "$HANDLERS" ]] || HANDLERS="$(realpath -e "$HANDLERS")" || die "no such file: $HANDLERS"
fi

ID="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
# Written beside its final name, then renamed: the daemon never reads half a request.
TMP="$APPS/requests/.$ID.tmp"
python3 - "$TMP" "$ID" "$ACTION" "$NAME" "$KIND" "$APP_PATH" "$HANDLERS" "$DESCRIPTION" <<'PY'
import json, sys
out, rid, action, name, kind, path, handlers, desc = sys.argv[1:9]
req = {"id": rid, "action": action, "name": name}
if action == "declare":
    req.update(kind=kind, path=path, description=desc)
    if handlers: req["handlers"] = handlers
json.dump(req, open(out, "w"))
PY
mv "$TMP" "$APPS/requests/$ID.json"

ANSWER="$APPS/answers/$ID.json"
for _ in $(seq 1 60); do [[ -f "$ANSWER" ]] && break; sleep 1; done
[[ -f "$ANSWER" ]] || die "no answer from the daemon within a minute (request $ID); try 'serve-app.sh status $NAME' later"
read -r OK MESSAGE < <(python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); print("ok" if a["ok"] else "refused", a["message"])' "$ANSWER")
if [[ "$OK" != ok ]]; then
    echo "Refused: $MESSAGE" >&2
    exit 2
fi
echo "$ACTION $NAME: $MESSAGE"

if [[ "$ACTION" == declare || "$ACTION" == start ]]; then
    for _ in $(seq 1 150); do
        STATE="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["status"])
except Exception: print("unknown")' "$APPS/status/$NAME.json")"
        [[ "$STATE" == running || "$STATE" == failed || "$STATE" == stopped ]] && break
        sleep 1
    done
    show_status "$NAME"
    if [[ "$STATE" == running ]]; then
        echo "The operator opens it from the Apps tab of the mission cockpit. Tell them it is there."
    else
        LOG="${WORKDIR:-}/logs/app-$NAME.log"
        if [[ -n "${WORKDIR:-}" && -f "$LOG" ]]; then
            echo "--- last lines of $LOG ---"
            tail -n 30 "$LOG"
        fi
        exit 3
    fi
fi
