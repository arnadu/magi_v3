#!/usr/bin/env python3
"""Read or move a reviewer's cursor: the last commit it has fully reviewed.

All reviewers share one file, shared/reports/review-cursor.json, one key per
agent, so each can see what the others have covered. Writes are atomic.

Uses $SHARED_DIR and $AGENT_ID (set for every agent Bash call).

Usage:
  python3 cursor.py get
  python3 cursor.py set <commit-sha> [note]
  python3 cursor.py show
"""
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def main():
    shared, agent = os.environ.get("SHARED_DIR"), os.environ.get("AGENT_ID", "")
    if not shared or len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    path = os.path.join(shared, "reports", "review-cursor.json")
    data = load(path)

    if cmd == "show":
        print(json.dumps(data, indent=2))
        return
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", agent):
        sys.exit("cursor: AGENT_ID is missing or invalid")

    if cmd == "get":
        entry = data.get(agent)
        if not entry:
            sys.exit(f"cursor: no cursor for {agent}; set one first")
        print(entry["commit"])
        return
    if cmd == "set":
        if not args or not re.fullmatch(r"[0-9a-f]{7,40}", args[0]):
            sys.exit("cursor: set needs a commit sha (7-40 hex characters)")
        data[agent] = {
            "commit": args[0],
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "note": " ".join(args[1:])[:200],
        }
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".cursor-")
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o664)
        os.replace(tmp, path)
        print(f"{agent} -> {args[0]}")
        return
    sys.exit(f"cursor: unknown command {cmd!r}")


if __name__ == "__main__":
    main()
