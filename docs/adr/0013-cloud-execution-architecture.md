# ADR-0013: Cloud Execution Architecture — Fly.io Machines

## Status

Accepted and implemented (Sprint 14).

## Context

Sprints 1–13 built a complete multi-agent backend that runs well locally. Sprint 14 makes
it deployable to the cloud. The architecture must:

- Run multiple concurrent missions with full isolation between them
- Sleep missions cheaply between active sessions (equity research runs once daily; paying
  for idle compute is wasteful)
- Persist agent workspace (files, git history, data factory outputs) across mission restarts
  and code deploys
- Give operators a web dashboard without requiring terminal access
- Keep execution plane machines off the public internet (they hold LLM API keys)
- Deploy both code layers automatically on every push to `main`

### Candidates evaluated

| Approach | Sleep when idle | Workspace persistence | Private networking | Ops complexity |
|----------|----------------|-----------------------|-------------------|----------------|
| **Fly.io Machines API** | Yes — stop/start in ~5 s | Fly Volumes (attached to machine) | Free WireGuard mesh | Low |
| Kubernetes (GKE/EKS) | Yes — scale to 0 | PVC + StatefulSet | VPC peering (paid) | High |
| AWS ECS Fargate | Partial — task stop/start ~60 s | EFS mount (slow, paid) | VPC (free within region) | Medium |
| Render.com | No free sleep | Persistent disk (paid) | Internal network | Low |
| Single always-on VM (Hetzner/DigitalOcean) | No | Native disk | Manual VPN | Low |

Kubernetes was rejected on ops complexity — requires cluster management, IAM, load
balancers, and persistent volume provisioning. The cost of idle compute for a few missions
is low in absolute terms but Fly.io's stop/start model eliminates it entirely.

A single always-on VM was rejected because it does not provide mission isolation — all
missions would share a process namespace and filesystem on one machine.

---

## Decision

Use **Fly.io Machines API** with a two-app architecture:

```
magi-control-{suffix}   (always-on, 256 MB)   — control plane
magi-missions-{suffix}  (on-demand machines)  — execution plane
```

Both apps run in the same Fly.io organisation and share a free WireGuard private network.

### Control plane (`magi-control-{suffix}`)

A single always-on machine deployed via `flyctl deploy` (standard Fly.io release model).
Responsibilities:
- Mission CRUD API + lifecycle (provision / suspend / resume / destroy)
- Fly Machines API client (`fly-machines.ts`) — creates and controls execution plane machines
- `node-cron` heartbeat — scans `scheduled_messages` and inserts into `mailbox` every minute
- HTTP reverse proxy — forwards `/missions/:id/**` to the execution plane over WireGuard
- Single-page operator dashboard (vanilla JS, no framework dependency)
- Auth middleware (`X-API-Key: CONTROL_API_KEY` header on all routes)

The control plane is the only component with a public HTTPS URL. All operator traffic
(dashboard, API, log viewer) flows through it.

### Execution plane (`magi-missions-{suffix}`)

A Fly.io app with **no deploy releases** — all machines are created and destroyed
programmatically via the Machines API from the control plane. One machine per active
mission.

Each machine:
- Has a Fly Volume (10 GB) mounted at `/missions` for workspace persistence
- Carries all runtime secrets in its machine `env` (injected at creation time — Fly
  app-level `secrets set` does NOT apply to Machines-API machines)
- Has no public services block — reachable only from the control plane via WireGuard
- Is stopped (suspended) when not actively running a session; restarted on schedule or
  on incoming mail

Machine configuration (set at creation time in `fly-machines.ts`):
```
cpu_kind: shared, cpus: 1, memory_mb: 1024
```
1 GB covers: Node.js + MongoDB driver + agent pool + reflection pass (~600 MB at idle)
+ Playwright/Chromium under active BrowseWeb load (~400 MB peak).

### Why the scheduler lives in the control plane

The daemon running on the execution plane cannot drive its own scheduled wakeups because
the machine is suspended between sessions. A suspended machine has no running process.
Moving `node-cron` to the always-on control plane solves this: the heartbeat fires every
minute, inserts pending `scheduled_messages` into the `mailbox` collection, and the
execution plane's Change Stream cursor fires immediately when the machine is running (or
picks up the message on next start if the machine was asleep when the insert happened).

### Workspace persistence model

```
Machine state     | Root filesystem | Fly Volume (/missions) | Outcome
─────────────────────────────────────────────────────────────────────────
suspend → resume  | preserved       | preserved              | Everything survives
Machine replace   | rebuilt from    | preserved              | Workspace + data survive;
(code update)     | new image       |                        | image rebuilt from scratch
Destroy mission   | deleted         | deleted                | Irreversible; MongoDB retained
```

Resumes reuse the existing machine — same Volume, same machine ID. Code updates that
require a new machine (image rebuild) can reattach the existing Volume by stopping the old
machine and creating a new one with `mounts: [{ volume: volumeId, path: "/missions" }]`.

### FLY_MISSIONS_IMAGE pin

The control plane reads `FLY_MISSIONS_IMAGE` from its env when provisioning machines.
If unset, it defaults to `registry.fly.io/{appName}:latest`. The CI workflow clears this
pin after pushing a new image, ensuring the next provision picks up the latest build.
Setting the pin to a specific SHA tag allows a test environment to lock to a known image
version without affecting the dev environment.

### Environment naming convention

Bootstrap accepts `--suffix <name>` to create named Fly.io app pairs:

| Suffix | Purpose |
|--------|---------|
| `dev` | CI target; auto-deployed on push to `main` |
| `test-<label>` | Isolated integration test environment; can reuse dev worker image |
| `prod-<usecase>` | Production mission |

Each environment must use a **distinct MongoDB database** (different `dbName` in the URI).
All control planes pointing at the same database share the `missions` collection — this
is intentional for multi-operator production but must be avoided for test isolation.

---

## Consequences

- **No public execution plane URL**: agents cannot be reached directly from the internet.
  All inbound operator traffic goes through the control plane proxy. This eliminates a
  class of direct-to-agent attack surface.
- **Fly app-level `secrets set` does not reach execution plane machines**: secrets must be
  passed in the machine `env` dict at creation time in `fly-machines.ts`. Adding a new
  runtime secret requires updating `fly-machines.ts` and re-provisioning existing missions.
- **Machines API vs regular deploy**: `flyctl deploy` cannot be used for the execution
  plane app because it has no release (no `fly.toml` with `[[services]]`). Running
  `flyctl secrets set -a magi-missions-{suffix}` triggers a rolling restart that fails
  for the same reason.
- **Fly.io IPv6 SSRF risk**: execution plane machines are on the `fdaa::/8` WireGuard
  range. `ssrf.ts` must block `fdaa:` and the broader ULA range (`fd[0-9a-f]{2}:`) to
  prevent agents from reaching other machines in the org via `FetchUrl` or `BrowseWeb`.
  See security findings for the current SSRF regex coverage.
- **Control plane memory**: 256 MB is sufficient for Express + MongoDB driver + proxy +
  cron. The control plane does not execute agent code or run Playwright.
- **Cold start latency**: a suspended machine takes ~5–15 seconds to resume. Operators
  see "starting" status during this window; the dashboard reconnects automatically once
  the monitor server is up.

## Files

| File | Role |
|------|------|
| `packages/control-plane/src/fly-machines.ts` | Machines API client: provision, suspend, resume, destroy |
| `packages/control-plane/src/scheduler.ts` | `node-cron` heartbeat: delivers `scheduled_messages` → `mailbox` |
| `packages/control-plane/src/proxy.ts` | HTTP proxy: `/missions/:id/**` → execution plane `:4000` |
| `packages/control-plane/src/missions.ts` | Mission CRUD routes; lifecycle state machine |
| `packages/agent-runtime-worker/Dockerfile` | Multi-stage image: Node + pool users + Playwright |
| `fly.control-dev.toml` | Control plane Fly.io app config (always-on, 256 MB) |
| `scripts/bootstrap.sh` | One-command environment setup; idempotent |
| `.github/workflows/build-execution-image.yml` | Builds + pushes execution plane image on code change |
| `.github/workflows/deploy-control-plane.yml` | Deploys control plane on code change |
