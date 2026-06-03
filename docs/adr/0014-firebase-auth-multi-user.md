# ADR-0014 — Firebase Authentication and Multi-User Isolation

**Status**: Accepted  
**Sprint**: 23  
**Date**: 2026-06

---

## Context

MAGI V3 shipped with a single shared `CONTROL_API_KEY` — all operators shared the same credential
and could see each other's missions. Sprint 23 adds per-user identity so missions are scoped to
their owner and LLM costs can be tracked per user.

Requirements:
- Google OAuth (no email/password for V3)
- Keep `CONTROL_API_KEY` as admin/CI fallback (no disruption to headless scripts or bootstrap)
- New tabs (mission dashboard) must be authenticated without URL-embedded tokens

---

## Decision

### 1. Firebase Authentication (existing projects)

Reuse the existing MAGI V2 Firebase projects rather than creating new ones:

| Environment | Firebase project |
|-------------|-----------------|
| Local dev + Fly dev | `magi-68bb2` |
| Fly prod | `magi-prod-b9403` |

This avoids OAuth app review and domain configuration work for a new project.

### 2. Dual-mode auth middleware

`auth.ts` accepts four credential locations in priority order:

```
Authorization: Bearer <token>   (API clients, apiFetch in UI)
X-Api-Key: <key>                (legacy API clients)
Cookie: magi_session=<token>    (new tabs, cross-tab auth)
?token=<token>                  (SSE EventSource — can't set headers)
```

`CONTROL_API_KEY` → `req.userId = "admin"`, `req.isAdmin = true` (sees all missions)  
Firebase JWT → `req.userId = Firebase UID`, `req.isAdmin = false` (sees own missions only)

### 3. magi_session cookie for cross-tab auth

The mission dashboard opens in a new browser tab. New tabs cannot inherit JS-memory tokens.
Rather than appending `?token=` to the dashboard URL (which would appear in browser history and
bookmarks), the frontend sets a `magi_session` cookie on successful auth:

- Firebase path: `onIdTokenChanged` fires on sign-in and every ~1h token refresh; cookie updated each time
- Admin key path: cookie set on sign-in, cleared on sign-out
- `SameSite=Strict`, `max-age=3600`, `path=/`

The server's `extractCookie` already `decodeURIComponent`s the value, so the URL-encoded JWT
round-trips correctly.

### 4. Firebase UID as userId

Firebase UID is used directly as `userId` throughout — no separate MongoDB mapping needed.
The `users` collection stores email and display name for display purposes, not for identity.

### 5. Serving environment-specific Firebase client config

`index.html` is a static file; it cannot differ between dev and prod deployments without a rebuild.
An unauthenticated `/firebase-config.js` endpoint is served by Express from env vars:

```javascript
window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "..." };
```

The frontend loads this script before initializing Firebase, then calls
`firebase.initializeApp(window.FIREBASE_CONFIG)`. The config values are public client-side
identifiers — they appear in every Firebase web app and are not secrets.

---

## Alternatives considered

### Email/password auth
Rejected — adds password reset, account recovery, and brute-force protection complexity.
Google OAuth handles all of this.

### JWT stored as httpOnly cookie (server-set)
Would require the server to parse and proxy Firebase tokens rather than verify them. Adds
statefulness to the control plane. Cookie approach instead stores the client-managed Firebase
JWT in a client-accessible cookie — simpler, and the server just verifies it on each request.

### ?token= in dashboard URL
Leaks the token into browser history, address bar, and any server-side access logs. The cookie
approach is invisible in URLs and works for all sub-requests from the dashboard page.

---

## Consequences

- Every request goes through Firebase JWT verification (async, ~5–10ms per call). Acceptable
  for the control plane's traffic volume.
- Firebase tokens expire every hour. The `onIdTokenChanged` hook auto-refreshes the cookie,
  but if the browser tab is idle for >1h with no activity, the next request will verify a
  refreshed token (Firebase SDK silently refreshes in the background).
- New deployments need Firebase Authorized Domains configured manually in the Firebase console
  (Authentication → Settings → Authorized domains). `bootstrap.sh` cannot automate this.
- `CONTROL_API_KEY` admin fallback means existing CI scripts, `curl` tests, and `bootstrap.sh`
  continue to work without any Firebase setup.

---

## Related

- [ADR-0013](0013-cloud-execution-architecture.md) — cloud infrastructure and auth boundary context
- `packages/control-plane/src/auth.ts` — middleware implementation
- `packages/control-plane/src/firebase.ts` — Firebase Admin SDK init + `verifyFirebaseToken`
- `docs/deployment.md §5` — Firebase project setup steps
