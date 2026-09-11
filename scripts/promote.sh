#!/usr/bin/env bash
# promote.sh — tag the current commit and deploy both planes to a named,
# non-dev environment (e.g. a beta tester's `prod-beta`).
#
# Wraps deploy-missions.sh (execution plane image + FLY_MISSIONS_IMAGE pin) and
# a control-plane `flyctl deploy` into one command, and tags the promoted
# commit first so "what version is this environment running" has a git-visible
# answer instead of only living in Fly's release history.
#
# Usage:
#   bash scripts/promote.sh --suffix prod-beta [--tag promote/prod-beta/custom-label]
#
# Requires a clean working tree — the whole point of the tag is that it names
# the exact committed state being deployed, not a mix of that plus whatever
# uncommitted local changes happened to be sitting around.
#
# Requires fly.control-{suffix}.toml and fly.missions-{suffix}.toml to already
# exist (created once by `bootstrap.sh --suffix {suffix}` — see docs/deployment.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[promote]${NC} $*"; }
success() { echo -e "${GREEN}[promote]${NC} $*"; }
die()     { echo -e "${RED}[promote] ERROR:${NC} $*" >&2; exit 1; }

SUFFIX=""
TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --suffix) SUFFIX="$2"; shift 2 ;;
    --tag)    TAG="$2"; shift 2 ;;
    --help)   grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$SUFFIX" ]] || die "Usage: bash scripts/promote.sh --suffix <name> [--tag <tag>]"
[[ "$SUFFIX" != "dev" ]] || die "dev deploys automatically on push to main (CI) — promote.sh is for named non-dev environments."

CONTROL_APP="magi-control-${SUFFIX}"
MISSIONS_APP="magi-missions-${SUFFIX}"
CONTROL_TOML="fly.control-${SUFFIX}.toml"
MISSIONS_TOML="fly.missions-${SUFFIX}.toml"

[[ -f "$CONTROL_TOML" ]] || die "$CONTROL_TOML not found — run 'bash scripts/bootstrap.sh --suffix $SUFFIX' once first."
[[ -f "$MISSIONS_TOML" ]] || die "$MISSIONS_TOML not found — run 'bash scripts/bootstrap.sh --suffix $SUFFIX' once first."

[[ -z "$(git status --porcelain)" ]] || die "Working tree has uncommitted changes — commit or stash them first. A promote tag must name an exact, reproducible commit."

if [[ -z "$TAG" ]]; then
  TAG="promote/${SUFFIX}/$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
fi

info "Environment : $SUFFIX"
info "Tag         : $TAG"
info "Commit      : $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"
echo ""

info "Tagging current commit…"
git tag "$TAG"
git push origin "$TAG"
success "Tag pushed: $TAG"

info "Deploying execution plane…"
bash scripts/deploy-missions.sh --suffix "$SUFFIX"

# packages/control-plane/public/ is gitignored — for -dev, CI's own workflow
# builds it fresh before every deploy (see packages/control-plane/Dockerfile's
# comment). A named non-dev environment has no such CI step (promote.sh is the
# whole point — see the top-of-file comment), so this is the only place that
# ever rebuilds it for one: skipping it silently ships whatever cockpit build
# happens to already be sitting on disk, which found live as a real user-
# visible bug (2026-09-11: a stale build masked a routing fix already merged
# to the source).
info "Building cockpit…"
npm run build --workspace=packages/cockpit
success "Cockpit built."

info "Deploying control plane…"
flyctl deploy --config "$CONTROL_TOML" --app "$CONTROL_APP"
success "Control plane deployed: https://${CONTROL_APP}.fly.dev"

echo ""
success "Promoted $TAG to $SUFFIX."
info "To roll back: git checkout <previous tag>, then re-run this script (it will refuse a dirty tree, so check out cleanly first)."
