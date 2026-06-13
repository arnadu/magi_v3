#!/usr/bin/env bash
# deploy-missions.sh — build and deploy the execution plane image, then pin
# FLY_MISSIONS_IMAGE on the control plane so new missions use the fresh image.
#
# Usage:
#   bash scripts/deploy-missions.sh                 # dev (default)
#   bash scripts/deploy-missions.sh --suffix prod   # production
#
# Why the pin is needed:
#   `flyctl deploy` creates a deployment-tagged image (deployment-<hash>) but does
#   NOT update :latest in the Fly registry. API-provisioned machines (our execution
#   plane) must specify an explicit image ref. Without the pin, new missions spin up
#   on whatever :latest pointed to last time bootstrap.sh ran — which may be weeks old.

set -euo pipefail

SUFFIX="dev"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --suffix) SUFFIX="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

MISSIONS_APP="magi-missions-${SUFFIX}"
CONTROL_APP="magi-control-${SUFFIX}"
MISSIONS_TOML="fly.missions-${SUFFIX}.toml"

if [[ ! -f "$MISSIONS_TOML" ]]; then
  echo "Error: $MISSIONS_TOML not found. Run from repo root." >&2
  exit 1
fi

echo "==> Building and deploying execution plane image to ${MISSIONS_APP}…"
flyctl deploy --config "$MISSIONS_TOML" --app "$MISSIONS_APP"

echo "==> Extracting deployment image tag…"
DEPLOY_IMAGE="$(flyctl releases --app "$MISSIONS_APP" --json 2>/dev/null \
  | python3 -c "import json,sys; rs=json.load(sys.stdin); print(rs[0]['ImageRef'])" 2>/dev/null)"

if [[ -z "$DEPLOY_IMAGE" ]]; then
  echo "Error: could not determine deployment image tag — FLY_MISSIONS_IMAGE not updated." >&2
  exit 1
fi

echo "==> Pinning FLY_MISSIONS_IMAGE on ${CONTROL_APP}: ${DEPLOY_IMAGE}"
flyctl secrets set "FLY_MISSIONS_IMAGE=${DEPLOY_IMAGE}" --app "$CONTROL_APP"

echo "Done. New missions will use: ${DEPLOY_IMAGE}"
echo "To update running missions: suspend + resume each one from the dashboard."
