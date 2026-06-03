# ADR-0015 — MonitorServer HMAC-derived per-mission auth token

**Status**: Accepted  
**Sprint**: 23  
**Date**: 2026-06

---

## Context

`MonitorServer` runs on each execution plane machine at port 4000. It exposes mutating routes
(`POST /stop`, `/send-message`, `/extend-budget`, `/toggle-step`, `/start`, `/files/*/write`,
`DELETE /schedule/:id`) that have no auth of their own (F-008).

The intended security model is "proxy is the perimeter": port 4000 is only reachable through
the control plane proxy (Fly WireGuard mesh is private). Sprint 23 fixed the proxy IDOR (F-019)
so only the mission owner can proxy through — but that left MonitorServer with no independent
layer. A compromised machine in the same Fly org could still reach port 4000 directly.

The fix must satisfy three constraints:
1. Per-mission isolation — machine A's token cannot unlock machine B
2. No secret storage in MongoDB — a DB compromise should not expose monitor tokens  
3. Local dev must continue to work without any token setup

---

## Decision

### HMAC derivation with a dedicated signing key

```
MONITOR_TOKEN(mission) = HMAC-SHA256(MONITOR_SIGNING_KEY, missionId)
```

`MONITOR_SIGNING_KEY` is a new control-plane-only Fly secret (generated with
`openssl rand -hex 32`). It is never forwarded to execution plane machines and never stored
in MongoDB. `missionId` is unique per mission, so every derived token is unique.

**Flow:**

```
Provision time (fly-machines.ts):
  → deriveMonitorToken(missionId) using MONITOR_SIGNING_KEY
  → MONITOR_TOKEN passed to machine as env var via Machines API

Per proxy request (proxy.ts):
  → deriveMonitorToken(missionId) re-computed in-process (zero latency, no DB read)
  → injected as x-monitor-token header before forwarding to port 4000

MonitorServer (monitor-server.ts):
  → reads MONITOR_TOKEN from process.env on startup
  → tokenOk(): checks x-monitor-token header on all non-GET requests
  → skips check when env var absent (local dev mode)
```

### Key separation from CONTROL_API_KEY

`MONITOR_SIGNING_KEY` is a separate secret from `CONTROL_API_KEY`:
- Compromising `CONTROL_API_KEY` does not expose monitor tokens (no blast-radius overlap)
- Compromising `MONITOR_SIGNING_KEY` does not grant API admin access
- Each can be rotated independently

### Why not store a random token in MongoDB?

Storing per-mission tokens in MongoDB was the first candidate. Rejected because:
- MongoDB is an existing trust boundary (TB-7); adding secrets there increases blast radius
- Requires an extra DB write at provision time and an extra DB read on every proxied request
- The HMAC approach achieves the same per-mission uniqueness with zero storage and zero latency

### Why not a single shared secret for all machines?

A single secret passed to all machines means compromise of one machine's env exposes all
machines. HMAC derivation limits the blast radius: the machine only knows its own
`MONITOR_TOKEN = HMAC(key, missionId)`, not the signing key. Knowing mission A's token reveals
nothing about mission B's token.

---

## Consequences

- `MONITOR_SIGNING_KEY` must be set as a Fly secret on the control plane app before deploying.
  `bootstrap.sh` auto-generates it if absent.
- If `MONITOR_SIGNING_KEY` is rotated, all running machines have the old `MONITOR_TOKEN` in
  their env. Their dashboards return 401 until the machine is re-provisioned or manually
  updated with `flyctl machine update --env MONITOR_TOKEN=<new-derived-value>`. See
  `docs/deployment.md §11` for the key-rotation procedure.
- Old machines (provisioned before this change) have no `MONITOR_TOKEN` env var; MonitorServer
  skips the check. Backward-compatible; no migration needed.
- Local dev: `MONITOR_SIGNING_KEY` not required; `MONITOR_TOKEN` absent → no check.

---

## Related

- [ADR-0014](0014-firebase-auth-multi-user.md) — Firebase Auth and the proxy ownership model
- `packages/control-plane/src/monitor-token.ts` — `deriveMonitorToken()` implementation
- `docs/security/findings.md` — F-008, F-019 (fixed in same sprint)
