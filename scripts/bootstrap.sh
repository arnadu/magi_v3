#!/usr/bin/env bash
# MAGI V3 — bootstrap.sh
#
# One-command setup: creates Fly.io apps, sets secrets, builds and pushes the
# execution plane Docker image, and deploys the control plane.
#
# Usage:
#   cp secrets.env.template secrets.env   # fill in API keys
#   bash scripts/bootstrap.sh
#
# Idempotent — safe to re-run. Existing apps and secrets are preserved unless
# you explicitly pass --reset-secrets.
#
# Options:
#   --suffix <name>        App name suffix (e.g. "prod" → magi-control-prod).
#                          Prompted interactively if not provided.
#   --secrets-file <path>  Path to secrets file (default: secrets.env at repo root).
#   --skip-docker          Skip Docker build and push (use existing image).
#   --skip-deploy          Skip control plane deploy (secrets + image only).
#   --reset-secrets        Re-set all Fly secrets even if apps already exist.
#   --help                 Show this message.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[bootstrap]${NC} $*"; }
success() { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn()    { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
die()     { echo -e "${RED}[bootstrap] ERROR:${NC} $*" >&2; exit 1; }

# ── Parse flags ───────────────────────────────────────────────────────────────
SUFFIX=""
SECRETS_FILE="$REPO_ROOT/secrets.env"
SKIP_DOCKER=false
SKIP_DEPLOY=false
RESET_SECRETS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --suffix)        SUFFIX="$2"; shift 2 ;;
    --secrets-file)  SECRETS_FILE="$2"; shift 2 ;;
    --skip-docker)   SKIP_DOCKER=true; shift ;;
    --skip-deploy)   SKIP_DEPLOY=true; shift ;;
    --reset-secrets) RESET_SECRETS=true; shift ;;
    --help)          grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ── Prerequisites ─────────────────────────────────────────────────────────────
info "Checking prerequisites…"
for cmd in flyctl docker git; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' not found. Install it and try again."
done
GH_AVAILABLE=false
command -v gh >/dev/null 2>&1 && GH_AVAILABLE=true || warn "'gh' CLI not found — GitHub secret will not be set automatically."

# ── Fly auth ──────────────────────────────────────────────────────────────────
info "Checking Fly.io authentication…"
flyctl auth whoami >/dev/null 2>&1 || {
  warn "Not authenticated with Fly.io. Running 'flyctl auth login'…"
  flyctl auth login
}
FLY_USER="$(flyctl auth whoami 2>/dev/null)"
info "Authenticated as: $FLY_USER"

# ── Suffix prompt ─────────────────────────────────────────────────────────────
if [[ -z "$SUFFIX" ]]; then
  echo ""
  echo "App name suffix (e.g. 'prod', 'dev', 'alice')."
  echo "Leave blank for no suffix (creates 'magi-control' and 'magi-missions')."
  read -rp "Suffix [none]: " SUFFIX
fi

if [[ -n "$SUFFIX" ]]; then
  CONTROL_APP="magi-control-${SUFFIX}"
  MISSIONS_APP="magi-missions-${SUFFIX}"
else
  CONTROL_APP="magi-control"
  MISSIONS_APP="magi-missions"
fi

info "Control plane app : $CONTROL_APP"
info "Execution plane app: $MISSIONS_APP"
echo ""

# ── Load secrets ──────────────────────────────────────────────────────────────
[[ -f "$SECRETS_FILE" ]] || die "Secrets file not found: $SECRETS_FILE\nCopy secrets.env.template to secrets.env and fill in your API keys."

info "Loading secrets from $SECRETS_FILE…"
# shellcheck disable=SC1090
set -o allexport
source "$SECRETS_FILE"
set +o allexport

# Validate required secrets
for var in ANTHROPIC_API_KEY MONGODB_URI CONTROL_API_KEY; do
  [[ -n "${!var:-}" ]] || die "$var is not set in $SECRETS_FILE"
done

# ── Create Fly apps (idempotent) ───────────────────────────────────────────────
create_app_if_missing() {
  local app="$1"
  if flyctl status -a "$app" >/dev/null 2>&1; then
    info "App '$app' already exists — skipping creation."
  else
    info "Creating Fly.io app: $app"
    flyctl apps create "$app" --machines
    success "Created: $app"
  fi
}

create_app_if_missing "$CONTROL_APP"
create_app_if_missing "$MISSIONS_APP"

# ── Generate FLY_API_TOKEN_MACHINES ───────────────────────────────────────────
info "Generating scoped Fly API token for Machines API (1-year expiry)…"
MACHINES_TOKEN="$(flyctl tokens create deploy -a "$MISSIONS_APP" --expiry 8760h --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
[[ -n "$MACHINES_TOKEN" ]] || die "Failed to generate FLY_API_TOKEN_MACHINES."
success "FLY_API_TOKEN_MACHINES generated."

# ── Set Fly secrets ───────────────────────────────────────────────────────────
set_secrets_if_needed() {
  local app="$1"; shift
  local -n pairs="$1"  # nameref to associative array

  if [[ "$RESET_SECRETS" == true ]]; then
    info "Setting secrets on $app (--reset-secrets)…"
  else
    # Check if secrets are already set by looking for any known key
    local first_key="${!pairs[*]%% *}"
    if flyctl secrets list -a "$app" --json 2>/dev/null | grep -q "\"$first_key\""; then
      info "Secrets already set on $app — skipping (use --reset-secrets to overwrite)."
      return 0
    fi
    info "Setting secrets on $app…"
  fi

  local args=()
  for key in "${!pairs[@]}"; do
    [[ -n "${pairs[$key]}" ]] && args+=("${key}=${pairs[$key]}")
  done
  [[ ${#args[@]} -gt 0 ]] && flyctl secrets set -a "$app" "${args[@]}"
  success "Secrets set on $app."
}

declare -A CONTROL_SECRETS=(
  [MONGODB_URI]="${MONGODB_URI}"
  [CONTROL_API_KEY]="${CONTROL_API_KEY}"
  [FLY_API_TOKEN_MACHINES]="${MACHINES_TOKEN}"
  [FLY_MISSIONS_APP_NAME]="${MISSIONS_APP}"
  [FIREBASE_SERVICE_ACCOUNT_KEY]="${FIREBASE_SERVICE_ACCOUNT_KEY:-}"
  [FIREBASE_CLIENT_API_KEY]="${FIREBASE_CLIENT_API_KEY:-}"
  [FIREBASE_CLIENT_AUTH_DOMAIN]="${FIREBASE_CLIENT_AUTH_DOMAIN:-}"
  [FIREBASE_CLIENT_PROJECT_ID]="${FIREBASE_CLIENT_PROJECT_ID:-}"
)
set_secrets_if_needed "$CONTROL_APP" CONTROL_SECRETS

declare -A MISSIONS_SECRETS=(
  [ANTHROPIC_API_KEY]="${ANTHROPIC_API_KEY}"
  [MONGODB_URI]="${MONGODB_URI}"
  [MONITOR_PORT]="4000"
  [TOOL_PORT]="4001"
  [BRAVE_SEARCH_API_KEY]="${BRAVE_SEARCH_API_KEY:-}"
  [FRED_API_KEY]="${FRED_API_KEY:-}"
  [FMP_API_KEY]="${FMP_API_KEY:-}"
  [NEWSAPIORG_API_KEY]="${NEWSAPIORG_API_KEY:-}"
  [OPENROUTER_API_KEY]="${OPENROUTER_API_KEY:-}"
)
set_secrets_if_needed "$MISSIONS_APP" MISSIONS_SECRETS

# ── Build and push Docker image ────────────────────────────────────────────────
IMAGE="registry.fly.io/${MISSIONS_APP}:latest"

if [[ "$SKIP_DOCKER" == false ]]; then
  info "Authenticating with Fly Docker registry…"
  flyctl auth docker

  info "Building execution plane image → $IMAGE"
  docker build \
    -f packages/agent-runtime-worker/Dockerfile \
    -t "$IMAGE" \
    .

  info "Pushing image…"
  docker push "$IMAGE"
  success "Image pushed: $IMAGE"
else
  warn "--skip-docker: using existing image in registry."
fi

# ── Deploy control plane ───────────────────────────────────────────────────────
if [[ "$SKIP_DEPLOY" == false ]]; then
  info "Deploying control plane to $CONTROL_APP…"

  # flyctl needs the toml at the repo root so the build context is correct.
  # Use fly.control-dev.toml as a template (it has the right VM/service config).
  TEMPLATE_TOML="fly.control-dev.toml"
  DEPLOY_TOML="fly.control-${SUFFIX:-default}.toml"

  sed "s/^app = .*/app = \"${CONTROL_APP}\"/" "$TEMPLATE_TOML" > "$DEPLOY_TOML"

  flyctl deploy --config "$DEPLOY_TOML" --app "$CONTROL_APP"

  # Remove the generated toml unless it's the dev one (CI uses that).
  [[ "$DEPLOY_TOML" != "fly.control-dev.toml" ]] && rm -f "$DEPLOY_TOML"

  success "Control plane deployed: https://${CONTROL_APP}.fly.dev"
else
  warn "--skip-deploy: skipping control plane deployment."
fi

# ── GitHub Actions secret ─────────────────────────────────────────────────────
if [[ "$GH_AVAILABLE" == true ]]; then
  info "Generating CI deploy token (image push scope)…"
  CI_TOKEN="$(flyctl tokens create deploy -a "$MISSIONS_APP" --expiry 8760h --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
  if [[ -n "$CI_TOKEN" ]]; then
    gh secret set FLY_API_TOKEN_CI --body "$CI_TOKEN" 2>/dev/null && \
      success "GitHub secret FLY_API_TOKEN_CI set." || \
      warn "Failed to set GitHub secret — set FLY_API_TOKEN_CI manually in your repo settings."
  fi
else
  echo ""
  warn "Set the following GitHub Actions secret manually:"
  warn "  Name:  FLY_API_TOKEN_CI"
  warn "  Value: a deploy token from 'flyctl tokens create deploy -a ${MISSIONS_APP}'"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
success "Bootstrap complete!"
echo ""
echo "  Control plane:  https://${CONTROL_APP}.fly.dev"
echo "  Execution pool: ${MISSIONS_APP} (machines created per mission)"
echo "  Image:          ${IMAGE}"
echo ""
echo "  Sign in with Google OAuth (or use CONTROL_API_KEY as admin fallback)"
echo ""
