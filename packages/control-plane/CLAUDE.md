# control-plane

Express API (missions CRUD and lifecycle), the Fly Machines client, the scheduler and resource
monitor ticks, the reverse proxy to mission machines, the control-plane copilot, and the
cockpit's static files (`public/`, built by CI from `packages/cockpit`). Loaded on top of the
root `CLAUDE.md` when working in this package.

## Commands

```bash
# Dev deploys only through CI (push to main): the cockpit bundle in public/ is built there,
# so a local `flyctl deploy` of the control plane ships a stale or missing cockpit.
bash scripts/deploy-missions.sh                  # execution plane: builds the image and pins
                                                 # FLY_MISSIONS_IMAGE so new missions use it —
                                                 # never a bare `flyctl deploy` of the missions app
bash scripts/promote.sh --suffix <name>          # tag HEAD + deploy both planes to a named
                                                 # non-dev environment; refuses a dirty tree

# Reconcile Mongo mission state against real Fly machines/volumes — report-only by default.
# --fix-status corrects drift (compare-and-set); --purge-orphans destroys untracked Fly
# resources (prints a plan, acts only with --yes, never touches attached volumes, machines with
# a mount, or anything younger than --min-age-hours, default 24).
# Needs MONGODB_URI, FLY_API_TOKEN_MACHINES, FLY_MISSIONS_APP_NAME.
node scripts/reconcile-mission-state.mjs [--fix-status] [--purge-orphans [--yes] [--min-age-hours N]]
```

Push to `main` deploys dev through CI (quality gates, control-plane deploy, execution image
build and pin). Deployment guide: [`docs/deployment.md`](../../docs/deployment.md).

## Environment, operationally

Full list: [`docs/env.md`](../../docs/env.md). The ones that change behaviour:

- `FIREBASE_SERVICE_ACCOUNT_KEY` (Google sign-in, minified JSON) and the public
  `FIREBASE_CLIENT_*` values served at `/firebase-config.js`.
- `PLATFORM_MAX_COST_CEILING_USD` (default 100) — written on every new mission and back-filled
  at start; a mission's cap never exceeds its ceiling, and only `CONTROL_API_KEY` (or a user in
  `PLATFORM_ADMIN_USER_IDS`, from the cockpit) may set a ceiling above it. New missions start
  with a $25 cap. Operator guide: `docs/spend-limits.md`; ADR-0034.
- `MONITOR_SIGNING_KEY` — HMAC key for per-mission monitor tokens; never forwarded to mission
  machines.
- `CSP_ENFORCE` — `"true"` makes the cockpit CSP enforcing (default report-only; violations are
  logged as `[csp] violation …`).
- `GH_TOKEN`, `GITHUB_REPO` (default `arnadu/magi_v3`) — the copilots' GitHub tools; every
  GitHub write is a pending action the operator confirms.
- `FLY_MISSIONS_IMAGE` — the image new mission machines use; pinned by CI after each build.
- `TEMPLATE_ALLOWLIST` — restricts which `config/teams/*.yaml` templates a deployment offers.
- `PLATFORM_ADMIN_USER_IDS` — Firebase UIDs that receive the Atlas alert and the report's Atlas
  section. `ATLAS_STORAGE_LIMIT_MB` (default 10240, the M10 tier). `RESOURCE_REPORT_HOUR_UTC`
  (default 12) — the daily report is sent at or after this hour, catching up later that day if
  the control plane was down.

## Conventions in this package

- Every route handler goes through `asyncRoutes` (tripwire T7); routes are grouped in
  `mission-routes-*.ts` modules over `MissionRouteDeps`.
- Mission machines are reached through `monitorUrl()` with `monitorAuthHeaders()`; never build
  the URL by hand.
- Anything a copilot proposes that writes outside its own sandbox is a pending action
  (`copilotPendingActions`) the operator confirms in the cockpit.
