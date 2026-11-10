#!/usr/bin/env bash
# Clone or update a repository listed in the mission's team/repositories.json,
# inside the calling agent's own working directory. Prints the clone path and
# the commit it is at. Read-only towards the remote: never pushes.
#
# Usage: bash repo-sync.sh [repository-name]
#   Uses $SHARED_DIR and $WORKDIR (set for every agent Bash call);
#   repository-name defaults to the first entry.
set -euo pipefail

: "${SHARED_DIR:?repo-sync: SHARED_DIR is not set}"
: "${WORKDIR:?repo-sync: WORKDIR is not set}"
NAME="${1:-}"
REPOS_FILE="$SHARED_DIR/team/repositories.json"

[ -f "$REPOS_FILE" ] || { echo "repo-sync: $REPOS_FILE not found; the mission config has no team/repositories.json" >&2; exit 2; }

# One line: url<TAB>branch<TAB>clone
ENTRY=$(python3 - "$REPOS_FILE" "$NAME" <<'PY'
import json, re, sys
repos = json.load(open(sys.argv[1]))["repositories"]
name = sys.argv[2]
r = next((x for x in repos if not name or x["name"] == name), None)
if r is None:
    sys.exit(f"repo-sync: no repository named {name!r} in {sys.argv[1]}")
if not re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+", r["url"]):
    sys.exit(f"repo-sync: refusing URL {r['url']!r} (only https://github.com/<owner>/<repo>)")
if not re.fullmatch(r"[\w./-]+", r["branch"]) or not re.fullmatch(r"[\w/-]+", r["clone"]) or ".." in r["clone"]:
    sys.exit("repo-sync: invalid branch or clone path in repositories.json")
print(f"{r['url']}\t{r['branch']}\t{r['clone']}")
PY
)
IFS=$'\t' read -r URL BRANCH CLONE <<<"$ENTRY"
DEST="$WORKDIR/$CLONE"

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --quiet origin "$BRANCH"
  git -C "$DEST" checkout --quiet --detach "origin/$BRANCH"
else
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --branch "$BRANCH" "$URL" "$DEST"
fi

echo "clone: $DEST"
echo "head: $(git -C "$DEST" rev-parse HEAD) ($(git -C "$DEST" log -1 --format='%cs %s'))"
