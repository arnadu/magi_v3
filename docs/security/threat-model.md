# MAGI V3 Threat Model

**Last updated:** Sprint 23 — Firebase Auth + multi-user + security hardening: TB-12/13/14 added; F-008 (MonitorServer HMAC token), F-019 (proxy IDOR), F-020 (pending-action ownership), F-009, F-016 all closed (2026-06-03)
**Update cadence:** Update whenever a new trust boundary, external service, or privilege level is added.

---

## Actors

| Actor | Trust level | Capabilities |
|-------|-------------|--------------|
| Admin operator (`CONTROL_API_KEY`) | **Fully trusted** | Posts messages, controls daemon, reads all missions; `req.isAdmin = true` |
| Authenticated user (Firebase JWT) | **User-trusted** | Creates and manages own missions; scoped to `userId = Firebase UID`; cannot see other users' missions via CRUD routes |
| Agent LLM output | **Conditionally trusted** | Calls tools within `AclPolicy`; confined to its `linuxUser` and `permittedPaths` |
| External web content | **Untrusted** | Injected into agent context via FetchUrl / BrowseWeb / SearchWeb / data adapters |
| Background job scripts | **Agent-trust** | Run as the agent's `linuxUser`; call ToolApiServer via short-lived bearer token |
| Other agents in mission | **Agent-trust** | Write to sharedDir; post mailbox messages; write mission skills |
| Fly.io Machines API | **External service** | Creates, starts, stops, destroys execution plane machines; does not access MongoDB or agent data |
| Firebase Auth service | **External identity provider** | Issues and validates Google OAuth JWTs; controls token lifetime (~1 h); MAGI V3 reuses existing V2 Firebase projects |

---

## Data Flow Diagrams

### Execution Plane — Internal Architecture

```mermaid
graph TB
    subgraph EXT ["External Internet (untrusted)"]
        WEB[Web pages / PDFs]
        BRAVE[Brave Search API]
        ANTHROPIC[Anthropic API]
        OPENROUTER["OpenRouter API\n(proxy → DeepSeek · Mistral\n+ others)"]
        DATAAPI["Data APIs\n(FMP · FRED · NewsAPI\nGDELT · yfinance · IMF)"]
    end

    subgraph OP ["Operator (trusted)"]
        BROWSER["Browser\n(Monitor dashboard)"]
        CLITOOL["CLI tools\ncli:post · cli:tail · cli:usage"]
    end

    subgraph HOST ["Execution Plane Machine"]
        subgraph DAEMON_PROC ["Process: magi-operator (orchestrator)"]
            DAEMON["Daemon\norchestration loop\nheartbeat · reflection"]
            TOOLAPI["ToolApiServer\n127.0.0.1:4001\nbearer token auth"]
            MONITOR["MonitorServer\n127.0.0.1:4000\n⚠️ no auth on mutating routes (F-008)"]
        end

        subgraph AGENT_PROC ["Subprocess: magi-wN (agent)"]
            TOOLEXEC["tool-executor\nBash · WriteFile · EditFile"]
            MAGIJOB["magi-job script\nbackground job"]
            MAGITOOL["magi-tool CLI"]
        end

        subgraph STORAGE ["Storage"]
            MONGO[("MongoDB\nmailbox · conversations\nscheduled_messages · llmCallLog")]
            SHARED["sharedDir\n(r/w all agents)\njobs/ · skills/ · logs/"]
            WORKDIR["workdir\n(per-agent private)"]
        end
    end

    %% Operator flows (local dev — direct access to port 4000)
    BROWSER -->|"GET/POST\n⚠️ no auth on mutating routes (F-008)"| MONITOR
    CLITOOL --> MONGO

    %% Daemon internal
    DAEMON <-->|CRUD| MONGO
    MONITOR <-->|"Change Stream\nSSE push"| MONGO
    DAEMON -->|"LLM calls (ANTHROPIC_API_KEY)"| ANTHROPIC
    DAEMON -->|"LLM calls (OPENROUTER_API_KEY)\nwhen MODEL or VISION_MODEL contains '/'"| OPENROUTER

    %% Daemon → external
    DAEMON -->|"FetchUrl · BrowseWeb\nSSRF blocked by ssrf.ts"| WEB
    DAEMON -->|SearchWeb| BRAVE

    %% Daemon → subprocesses (sudo boundary)
    DAEMON -->|"sudo -u magi-wN\nenv: PATH + HOME only"| TOOLEXEC
    DAEMON -->|"sudo -u magi-wN\nenv: +MAGI_TOOL_TOKEN\n+data keys"| MAGIJOB

    %% Subprocess filesystem access
    TOOLEXEC <-->|"r/w\n(Linux ACL enforced)"| WORKDIR
    TOOLEXEC <-->|"r/w"| SHARED
    MAGIJOB <-->|"r/w"| SHARED
    MAGIJOB -->|"data adapter calls"| DATAAPI

    %% Background job IPC
    MAGIJOB -->|exec| MAGITOOL
    MAGITOOL -->|"POST /tools/\nAuthorization: Bearer"| TOOLAPI
    TOOLAPI -->|"LLM calls"| ANTHROPIC
    TOOLAPI -->|"FetchUrl · BrowseWeb"| WEB
    TOOLAPI -->|SearchWeb| BRAVE

    %% Job spec files
    MAGIJOB -.->|"write spec (submit-job.sh)"| SHARED
    DAEMON -.->|"read pending specs"| SHARED
```

### Cloud Deployment — Control Plane + Execution Plane

```mermaid
graph TB
    subgraph OPERATOR ["Operator / User"]
        BROWSER2["Browser\nhttps://magi-control-{suffix}.fly.dev"]
    end

    subgraph CLOUD ["Fly.io (same org — private WireGuard mesh)"]
        subgraph CTRL ["Control Plane — magi-control-{suffix} · always-on · 256 MB"]
            CTRL_STATIC["/firebase-config.js + index.html\nunauthenticated · TB-14"]
            CTRL_API["Express API\nmissions CRUD + lifecycle\nauth.ts — dual-mode: Firebase JWT | CONTROL_API_KEY"]
            CTRL_PROXY["HTTP reverse proxy\n/missions/:id/**\ntarget resolved from MongoDB only\n⚠️ no userId scope (F-019)"]
            CTRL_CRON["node-cron\nscheduled_messages heartbeat"]
            FLY_CLIENT["Fly Machines client\nfly-machines.ts"]
            COPILOT["Copilot daemon (per user)\nmissionId = copilot-{uid}"]
        end

        subgraph EXEC ["Execution Plane — magi-missions-{suffix} · on-demand · 1 GB · one per mission"]
            MONITOR_CLOUD["MonitorServer :4000\nno public URL — internal only"]
            DAEMON_CLOUD["Daemon + agent pool"]
        end
    end

    subgraph EXT2 ["External Services"]
        FLY_API["Fly Machines API\napi.machines.dev/v1"]
        MONGO_ATLAS[("MongoDB Atlas\nmissions · users · mailbox\nconversations · llmCallLog")]
        LLM_API["Anthropic / OpenRouter APIs"]
        FIREBASE_AUTH["Firebase Auth\naccounts.google.com\n+ firestore JWT issuance · TB-12"]
    end

    BROWSER2 -->|"HTTPS — GET /firebase-config.js · TB-14"| CTRL_STATIC
    BROWSER2 <-->|"Google OAuth popup · TB-12"| FIREBASE_AUTH
    BROWSER2 -->|"HTTPS · Bearer JWT | X-Api-Key | magi_session cookie · TB-9 / TB-13"| CTRL_API
    BROWSER2 -->|"HTTPS · same auth · TB-9 / TB-13"| CTRL_PROXY
    CTRL_API --> CTRL_CRON
    CTRL_API --> FLY_CLIENT
    CTRL_API --> COPILOT
    CTRL_API <-->|"verifyIdToken · TB-12"| FIREBASE_AUTH
    FLY_CLIENT -->|"HTTPS · FLY_API_TOKEN_MACHINES · TB-10"| FLY_API
    FLY_API -.->|"provisions / controls"| EXEC
    CTRL_PROXY -->|"HTTP · WireGuard fdaa::/8 · TB-11"| MONITOR_CLOUD
    CTRL_API <-->|CRUD| MONGO_ATLAS
    CTRL_CRON <-->|"read / write"| MONGO_ATLAS
    COPILOT <-->|CRUD| MONGO_ATLAS
    DAEMON_CLOUD <-->|CRUD| MONGO_ATLAS
    DAEMON_CLOUD -->|"LLM calls"| LLM_API
```

---

## Trust Boundaries

| Boundary | Crossing mechanism | Direction |
|----------|--------------------|-----------|
| **TB-1** | External internet ↔ Daemon | HTTP (FetchUrl, BrowseWeb, APIs, LLM calls) | Inbound: untrusted content; Outbound: requests including full conversation context to LLM providers |
| **TB-2** | Operator ↔ MonitorServer (local dev) | HTTP GET/POST on localhost:4000; `MONITOR_TOKEN` env var absent in dev → no auth check on mutating routes | Bidirectional |
| **TB-3** | Daemon (magi-operator) ↔ tool-executor (magi-wN) | `sudo -u magi-wN`, clean env | Outbound: commands; Inbound: stdout/stderr |
| **TB-4** | Daemon ↔ magi-job (magi-wN) | `sudo -u magi-wN`, +token +data keys | Outbound: script + env; Inbound: exit code |
| **TB-5** | magi-job (magi-wN) ↔ ToolApiServer (magi-operator) | HTTP + bearer token, loopback | Outbound: tool calls; Inbound: results |
| **TB-6** | Agent LLM ↔ tool execution | Tool call parsing + AclPolicy | Agent-controlled input to privileged operations |
| **TB-7** | Agents ↔ sharedDir | Filesystem (Linux ACLs on workdirs; sharedDir open to all agents) | All agents read/write shared surface |
| **TB-8** | External content ↔ agent context | FetchUrl/BrowseWeb result injected into LLM messages | Untrusted text into trusted reasoning |
| **TB-9** | Browser → Control plane HTTPS | HTTPS to `magi-control-{suffix}.fly.dev`; dual-mode auth: `Authorization: Bearer <Firebase JWT>` (preferred), `X-Api-Key: <CONTROL_API_KEY>` (admin/CI), `Cookie: magi_session=<token>` (cross-tab), `?token=<token>` (SSE `EventSource`) | Bidirectional (REST API + SSE proxy) |
| **TB-10** | Control plane → Fly Machines API | HTTPS to `api.machines.dev/v1`; `FLY_API_TOKEN_MACHINES` bearer token | Outbound: machine lifecycle commands; Inbound: machine state |
| **TB-11** | Control plane proxy → Execution plane | HTTP over Fly WireGuard (`fdaa::/8`); proxy injects `x-monitor-token` header (HMAC-derived, unique per mission); MonitorServer checks token on all mutating routes | Bidirectional (proxy + SSE stream) |
| **TB-12** | Browser ↔ Firebase Auth (Google OAuth) | Browser opens Google OAuth popup; Firebase client SDK receives JWT; control plane calls `getAuth().verifyIdToken()` over HTTPS to Firebase Admin API | Outbound: auth request; Inbound: signed JWT; server calls Firebase to verify |
| **TB-13** | `magi_session` cookie → Control plane | Client-accessible cookie set by browser JS on sign-in; `SameSite=Strict`, `max-age=3600`, `path=/`; carries Firebase JWT or `CONTROL_API_KEY`; no `Secure` flag (Fly.io enforces HTTPS at load balancer) | Browser → server on every same-origin request |
| **TB-14** | `/firebase-config.js` unauthenticated endpoint | Express `GET /firebase-config.js` serves `FIREBASE_CLIENT_API_KEY`, `FIREBASE_CLIENT_AUTH_DOMAIN`, `FIREBASE_CLIENT_PROJECT_ID` from env as a JS snippet; no auth; `Cache-Control: no-store` | Server → browser; public (client-side Firebase identifiers, not secrets) |

---

## Implementing Files by Boundary

### TB-1: External HTTP requests (FetchUrl, BrowseWeb, data adapters, LLM providers)
- `packages/agent-runtime-worker/src/tools/fetch-url.ts` — HTTP GET, HTML/PDF extraction, image download
- `packages/agent-runtime-worker/src/tools/browse-web.ts` — Playwright/Stagehand, SSRF check (initial nav only)
- `packages/agent-runtime-worker/src/tools/research.ts` — Research sub-loop; calls FetchUrl and SearchWeb
- `packages/agent-runtime-worker/src/tools/search-web.ts` — Brave Search API call
- `packages/agent-runtime-worker/src/ssrf.ts` — `isPrivateHost()` regex + post-DNS-resolution check
- `packages/agent-runtime-worker/src/models.ts` — `parseModel()`: routes `/`-delimited IDs to OpenRouter; bare IDs to Anthropic
- `packages/skills/data-factory/scripts/adapters/` — all 7 Python adapters (fmp, fred, yfinance, newsapi, gdelt, imf, worldbank)

### TB-2: MonitorServer (local dev — operator interface)
- `packages/agent-runtime-worker/src/monitor-server.ts` — HTTP server + SSE; binds `127.0.0.1:4000`; mutating routes lack auth; `GET /log` returns daemon log file tail

### TB-3: tool-executor subprocess (Bash, WriteFile, EditFile)
- `packages/agent-runtime-worker/src/tools.ts` — `checkPath()`, `AclPolicy`, `spawnSync`, clean child env, `verifyIsolation()`
- `packages/agent-runtime-worker/src/tool-executor.ts` — clean child entry point; reads stdin, dispatches, writes stdout

### TB-4: magi-job subprocess (background jobs + token injection)
- `packages/agent-runtime-worker/src/daemon.ts` — `runPendingJobs()`: token mint, `sudo` spawn, token revoke, spec validation
- `scripts/setup-dev.sh` — `magi-job` wrapper at `/usr/local/bin/magi-job`, sudoers NOPASSWD + `env_keep` rules

### TB-5: ToolApiServer — magi-job → daemon IPC
- `packages/agent-runtime-worker/src/tool-api-server.ts` — HTTP server `127.0.0.1:4001`; bearer token auth; tool dispatch
- `packages/agent-runtime-worker/src/cli-tool.ts` — `magi-tool` CLI (Node.js client)
- `packages/skills/run-background/scripts/magi_tool.py` — Python SDK client (stdlib only)

### TB-6: AclPolicy enforcement (LLM output → privileged operations)
- `packages/agent-runtime-worker/src/tools.ts` — `checkPath()`, `PolicyViolationError`, Bash/WriteFile/EditFile dispatch
- `packages/agent-runtime-worker/src/agent-runner.ts` — tool registration, `AclPolicy` construction, `researchAcl`
- `packages/agent-runtime-worker/src/loop.ts` — `maxTurns` cap, tool call dispatch
- `packages/agent-runtime-worker/src/orchestrator.ts` — `isAgentPaused?(agentId)` hook: future Copilot authority surface for pausing agents; currently no-op in production; Sprint 18 will wire the Copilot to this callback — the daemon must validate that pause requests originate from the Copilot agent only

### TB-7: sharedDir shared write surface
- `packages/agent-runtime-worker/src/workspace-manager.ts` — `setfacl` provisioning, dir creation, git init
- `packages/agent-runtime-worker/src/skills.ts` — `discoverSkills()`: SKILL.md frontmatter parsing, scope precedence
- `packages/agent-runtime-worker/src/daemon.ts` — scheduled message upsert (`spec.label` filter), job spec file reads

### TB-8: Untrusted content → agent context (prompt injection)
- `packages/agent-runtime-worker/src/tools/fetch-url.ts` — tool result (markdown) injected into LLM messages
- `packages/agent-runtime-worker/src/tools/browse-web.ts` — trust boundary markers wrapping Stagehand output
- `packages/agent-runtime-worker/src/prompt.ts` — `buildSystemPrompt()`: mental map + skills block → system prompt
- `packages/agent-runtime-worker/src/mental-map.ts` — `patchMentalMap()`: jsdom surgical patching of agent-written HTML
- `packages/agent-runtime-worker/src/reflection.ts` — cumulative summary injected as user message at session start
- `packages/agent-runtime-worker/src/mailbox.ts` — `listMessages` `$regex` search; message bodies formatted as user turns

### TB-9: Browser → Control plane HTTPS (dual-mode auth)
- `packages/control-plane/src/auth.ts` — `createAuthMiddleware(db)`: extracts credential from Bearer header / `X-Api-Key` / `magi_session` cookie / `?token=` query param; validates `CONTROL_API_KEY` first, then Firebase JWT via `verifyFirebaseToken`; sets `req.userId` and `req.isAdmin`
- `packages/control-plane/src/firebase.ts` — `initFirebase()`: Firebase Admin SDK init from `FIREBASE_SERVICE_ACCOUNT_KEY` (preferred) or `applicationDefault()` + `FIREBASE_PROJECT_ID`; `verifyFirebaseToken()`: calls `getAuth().verifyIdToken()`
- `packages/control-plane/src/users.ts` — `syncFirebaseUser()`: upserts `uid`, `email`, `displayName`, `lastLoginAt` into `users` collection on every authenticated request; `uid` is never derived from request body
- `packages/control-plane/src/missions.ts` — `userFilter(req)`: admin sees all (`{}`); regular user sees only `{ userId: req.userId }`; applied to all CRUD + lifecycle queries
- `packages/control-plane/src/index.ts` — Express app assembly; `requireAuth` applied globally after static files and `/firebase-config.js`; rate limit (30 req/60 s) on `/api/copilot`

### TB-12: Browser ↔ Firebase Auth (Google OAuth)
- `packages/control-plane/src/firebase.ts` — server-side token verification via Firebase Admin SDK
- `packages/control-plane/public/index.html` — client-side: `firebase.initializeApp(window.FIREBASE_CONFIG)`; `signInWithPopup(GoogleAuthProvider)`; `onIdTokenChanged` hook updates `magi_session` cookie on token refresh

### TB-13: `magi_session` cookie
- `packages/control-plane/public/index.html` — `setSessionCookie(token)` sets `magi_session=<encoded-token>; path=/; SameSite=Strict; max-age=3600`; `clearSessionCookie()` on sign-out; cookie updated on every `onIdTokenChanged` event
- `packages/control-plane/src/auth.ts` — `extractCookie()`: parses cookie header, `decodeURIComponent`s the JWT value; cookie value fed into same auth pipeline as Bearer token

### TB-14: `/firebase-config.js` unauthenticated endpoint
- `packages/control-plane/src/index.ts` — `GET /firebase-config.js`: serves `FIREBASE_CLIENT_API_KEY`, `FIREBASE_CLIENT_AUTH_DOMAIN`, `FIREBASE_CLIENT_PROJECT_ID` as `window.FIREBASE_CONFIG`; registered before `requireAuth` middleware; `Cache-Control: no-store`

### TB-10: Control plane → Fly Machines API
- `packages/control-plane/src/fly-machines.ts` — Machines API client; reads `FLY_API_TOKEN_MACHINES` and `FLY_MISSIONS_APP_NAME` from env only; never user-supplied
- `packages/control-plane/src/scheduler.ts` — node-cron heartbeat; calls `resumeMission()` before delivering scheduled messages

### TB-11: Control plane proxy → Execution plane
- `packages/control-plane/src/proxy.ts` — resolves `privateIp` from MongoDB `missions` collection by `{ missionId, userId }` (F-019 fixed); validates machine state; re-derives `MONITOR_TOKEN = HMAC-SHA256(MONITOR_SIGNING_KEY, missionId)` and injects as `x-monitor-token` header
- `packages/control-plane/src/monitor-token.ts` — `deriveMonitorToken(missionId)`: HMAC-SHA256 using `MONITOR_SIGNING_KEY` (control-plane-only Fly secret); returns empty string when key is absent (local dev)
- `packages/agent-runtime-worker/src/monitor-server.ts` — reads `MONITOR_TOKEN` env var (set at provision); `tokenOk()` checks `x-monitor-token` header on all non-GET requests; skips check when env var absent (dev mode)
- `packages/control-plane/src/fly-machines.ts` — derives and injects `MONITOR_TOKEN` into machine env at provision time; `MONITOR_SIGNING_KEY` never leaves the control plane

### MongoDB `users` collection (new Sprint 23 surface)
- `packages/control-plane/src/users.ts` — `syncFirebaseUser()` upserts on every authenticated request; stores `uid` (Firebase UID, used as `userId` throughout), `email`, `displayName`, `createdAt`, `lastLoginAt`; no secrets stored; `uid` is never derived from request body
- `packages/control-plane/src/copilot-router.ts` — `missionId = copilot-{userId}` provides per-user daemon namespace; `CopilotEventBus` segregates SSE streams by `userId`

### Per-user copilot daemons (`copilot-{uid}`)
- `packages/control-plane/src/copilot-router.ts` — `ensureCopilotRunning(userId)` lazily starts one daemon per authenticated user keyed by Firebase UID; `missionId = copilot-{userId}` isolates mailbox and conversation namespaces; SSE events routed per `userId` via `CopilotEventBus`
- `packages/control-plane/src/copilot-tools.ts` — `PendingAction.userId` stamps the owning user on every proposed action; `confirm` and `dismiss` verify `action.userId === req.userId` before executing (F-020 fixed)

---

## STRIDE Threat Table

`✅` = mitigated; `⚠️` = open finding (see `findings.md`); `~` = partially mitigated; `A` = accepted.

### TB-1: External internet → FetchUrl / BrowseWeb

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| SSRF via FetchUrl — fetch internal RFC-1918 or cloud-metadata services | I / E | ✅ F-001 | Fixed Sprint 13: `ssrf.ts` `isPrivateHost()` validates hostname + post-DNS-resolution IP |
| SSRF via BrowseWeb post-navigation redirect | I / E | ✅ F-002 | Fixed Sprint 16: `page.route("**/*", handler)` intercepts document/xhr/fetch requests during `agent().execute()`; known gap: new tab/popup pages do not inherit handler |
| DNS rebinding — IP changes between check and connect | I | ~ | Post-redirect check in `fetch-url.ts` partially mitigates; fully resolved when F-002 is fixed |
| Oversized response — OOM crash | D | ✅ | 50 MB response cap; Content-Length checked before read |
| Malicious content injected into agent context | T | ~ | Trust boundary markers on BrowseWeb; FetchUrl result injected as plain markdown (see TB-8) |
| Full conversation context sent to OpenRouter third-party proxy | I | ~ | OpenRouter has separate data-retention policy; `OPENROUTER_API_KEY` is daemon-only, never forwarded to subprocesses |
| `OPENROUTER_API_KEY` leaked into tool-executor child env | I | ✅ F-017 | Clean-env spawn is the primary control; `verifyIsolation()` now checks both `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` |
| Fly.io WireGuard range (`fdaa::/8`) reachable via FetchUrl/BrowseWeb from execution plane | I / E | ~ | `ssrf.ts` blocks ULA prefix `fd[0-9a-f]{2}:` which covers `fdaa::`; verify after any `ssrf.ts` change |

### TB-2: Operator → MonitorServer (local dev)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Unauthenticated `POST /stop`, `/send-message`, `/extend-budget` | S / E | ⚠️ F-008 | Binds to `127.0.0.1:4000` (localhost only); no auth on mutating routes |
| SSE stream exposes all mission data on localhost | I | ⚠️ F-009 | Any process on the machine can subscribe to the full agent activity stream |
| `GET /log` exposes daemon stdout/stderr (may include agent message excerpts, internal paths) | I | ~ | In local dev: localhost-only (same as F-009). In production: behind TB-9 `X-API-Key` via proxy; only authenticated operators can reach it |

### TB-3: Daemon → tool-executor (sudo boundary)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| API key leaks into child process env | I | ✅ | Child receives PATH + HOME + workspace context (SHARED_DIR, WORKDIR, AGENT_ID — not secrets); `verifyIsolation()` at startup confirms ANTHROPIC_API_KEY absent |
| Agent writes to another agent's workdir via Bash | T / E | ✅ | OS Linux ACLs (setfacl); covered by `acl.integration.test.ts` |
| Shell injection in setfacl call | E | ✅ | `execFileSync("setfacl", [...])` — no shell interpolation |

### TB-4: Daemon → magi-job (sudo boundary + token injection)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| linuxUser escalation via crafted job spec | E | ✅ | `linuxUser` removed from `JobSpec`; derived from `agentId` via team config (S12-A5) |
| scriptPath traversal via symlink | T / E | ✅ F-013 | Fixed Sprint 13: `realpathSync()` after `join()`; real path checked against `permittedPaths` |
| `MAGI_TOOL_TOKEN` not revoked if `spawn()` throws | I | ✅ F-014 | Fixed Sprint 13: token issued inside try; catch revokes immediately |
| `MAGI_TOOL_TOKEN` exposed in job log files | I | A | Token short-lived (revoked on exit); logs within sharedDir only (A-003) |
| No wall-clock timeout — hung job holds concurrency slot | D | ✅ F-006 | Fixed Sprint 13: `DEFAULT_JOB_TIMEOUT_MS = 30 min`; SIGKILL to process group on expiry |
| Orphaned `jobs/running/` on daemon restart | D | ✅ F-010 | Fixed Sprint 13: `recoverOrphanedJobs()` at startup moves running → pending |

### TB-5: magi-job → ToolApiServer (bearer token)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Token theft — used by another process on same machine | S | ~ | Short-lived; bound to agent's AclPolicy; cannot escalate beyond it |
| Token exceeds agent's AclPolicy | E | ✅ | AclPolicy enforced by ToolApiServer on every call |
| Client timeout outlasts server timeout — concurrency slot held | D | ✅ F-015 | Fixed Sprint 13: Python SDK timeout 135 s (server 120 s + 15 s buffer) |

### TB-6: Agent LLM → tool execution (AclPolicy boundary)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Symlink traversal in WriteFile/EditFile | T / E | ✅ F-003 | Fixed Sprint 13: `realpathSync()` after `resolve()`; both resolved and real paths checked |
| `file://` LFI via FetchUrl | I | ✅ | `file://` protocol rejected at URL parse (S4-C1) |
| Bash timeout bypass — pass large timeout value | D | ✅ | Capped at 600 s (S4-M3) |
| Bash background processes escape spawnSync timeout | D | ✅ F-011 | Fixed Sprint 13: `execa` + `detached: true`; SIGKILL to process group |
| PostMessage to arbitrary recipient | T | ✅ | Recipient validated against team roster (S4-M2) |

### TB-7: Agents ↔ sharedDir (shared write surface)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Agent overwrites another agent's sharedDir output | T | A | Intentional design (collaboration); workdir ACL isolation is the backstop (A-001) |
| Adversarial SKILL.md in mission/ tier (prompt injection via skill description) | T | ~ | `description` injected into all agents' system prompts; no sanitisation; symlinks excluded in `discoverSkills()` |
| Agent writes crafted schedule label — MongoDB operator injection | T | ✅ F-005 | Fixed Sprint 13: `typeof spec.label !== 'string'` guard; invalid specs skipped |

### TB-8: External content → agent context (prompt injection)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Injected web content overrides agent instructions | T | ~ | BrowseWeb has trust boundary markers; FetchUrl result injected as plain markdown |
| Compromised agent writes adversarial HTML to mental map | T | ~ | `patchMentalMap` uses jsdom surgical patching; arbitrary section insertion possible via id-bearing elements |
| MongoDB `$regex` ReDoS via LLM-generated search string | D | ✅ F-004 | Fixed Sprint 13: metacharacters escaped; search string capped at 200 chars |

### TB-9: Browser → Control plane HTTPS

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| API key brute force or theft → unauthorized mission control | S | ✅ F-016 | Fixed Sprint 23: 30 req/60 s rate limit on `/api/copilot`; global Express rate limit at `trust proxy 1`; strong 32-byte random key + HTTPS |
| Malicious `missionId`/`teamConfig` parameters → path traversal | T | ✅ | `missionId` sanitised before use as volume/machine name; `teamConfig` resolved against fixed image paths only |
| API key intercepted in transit | I | ✅ | Fly.io enforces HTTPS on all `*.fly.dev` domains; HTTP redirects to HTTPS |
| Authenticated user accesses another user's mission via proxy route | S / I | ⚠️ F-019 | `proxy.ts` resolves target from `{ missionId }` — no `userId` filter applied; authenticated user who guesses or learns another user's `missionId` can proxy into that mission's MonitorServer |
| CONTROL_API_KEY stored in `magi_session` cookie exposes admin credential | I | ~ | Cookie is `SameSite=Strict` (blocks CSRF); no `HttpOnly` (JS-accessible by design for cross-tab); admin key in cookie has same lifetime as session tab |

### TB-12: Browser ↔ Firebase Auth (Google OAuth)

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Forged or expired Firebase JWT → unauthorized access | S | ✅ | `verifyIdToken()` (Firebase Admin SDK) validates signature, issuer, audience, and expiry on every request; expired tokens return 401 |
| Firebase project misconfiguration — unauthorized OAuth domain | S | ~ | Firebase console "Authorized domains" must list the Fly.io app domain; cannot be automated in `bootstrap.sh`; new deployments require manual step (ADR-0014) |
| Token replay across deployments (same Firebase project for dev + prod) | S | ~ | MAGI V3 reuses V2 Firebase projects; a token issued for one environment is valid for the other if the same `FIREBASE_SERVICE_ACCOUNT_KEY` is used — acceptable for current single-org deployment |
| Firebase service outage → all authenticated requests rejected | D | ~ | `initFirebase()` failure is caught and logged; `CONTROL_API_KEY` admin path is always available as fallback; no per-request Firebase availability check |

### TB-13: `magi_session` cookie

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Cookie theft via XSS → session hijacking | I | ~ | No `HttpOnly` flag (required for cross-tab JS access); XSS would expose the Firebase JWT; cookie limited to `SameSite=Strict` + 1 h lifetime |
| CSRF using cookie credential | T | ✅ | `SameSite=Strict` prevents cookie from being sent on cross-site-initiated requests |
| Cookie contains CONTROL_API_KEY (not just JWT) | I | ~ | When admin signs in with API key, the raw `CONTROL_API_KEY` is written to the `magi_session` cookie; any JS on the page can read it — same as sessionStorage risk, but cookie persists for 1 h across tab-close/reopen within the session |
| `magi_session` cookie not expiring server-side → replay after sign-out | S | ~ | Server has no session store; `max-age=3600` is client-enforced only; server cannot revoke a valid Firebase JWT before its 1 h expiry |

### TB-14: `/firebase-config.js` unauthenticated endpoint

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| `FIREBASE_CLIENT_API_KEY` treated as secret | I | A | Firebase client config values are public identifiers by design (appear in every Firebase web app); they do not grant backend access; `FIREBASE_SERVICE_ACCOUNT_KEY` is the server-side secret |
| Endpoint used to enumerate Firebase project | I | A | `projectId` and `authDomain` are visible in any public Firebase web app; no additional surface exposed |
| Missing `Cache-Control: no-store` → stale config after environment change | D | ✅ | Response sets `Cache-Control: no-store` |

### TB-10: Control plane → Fly Machines API

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| `FLY_API_TOKEN_MACHINES` theft → unauthorized machine creation/destruction | S | ~ | Token is deploy-scoped to one Fly app only; stored as Fly secret, not in code or image |
| Leaked token used to inject malicious env vars into new machines | T | ~ | App-scoped token cannot affect other Fly apps or Atlas; env vars at create time controlled by `fly-machines.ts` |
| `FLY_API_TOKEN_MACHINES` forwarded to execution plane machines | I | ✅ | `fly-machines.ts` explicitly does NOT include this token in machine `env` |
| App name or machine ID from user input → Machines API targeted to wrong app | T | ✅ | App name from `FLY_MISSIONS_APP_NAME` env var only; machine IDs from MongoDB `missions` collection only |

### TB-11: Control plane proxy → Execution plane

| Threat | Category | Status | Notes |
|--------|----------|--------|-------|
| Proxy target from user input → SSRF to internal Fly services | T / E | ✅ | `proxy.ts` resolves `privateIp` from MongoDB by `missionId`; never interpolates request parameters |
| Proxy forwards to stopped machine | D | ✅ | `proxy.ts` validates machine state == "running" before forwarding; returns 404 otherwise |
| Monitor server unauthenticated mutating routes exposed via proxy | S / E | ⚠️ F-008 | Outer auth (Firebase JWT or `CONTROL_API_KEY`) is the only auth layer; monitor's own mutating endpoints have no token check |
| Authenticated user accesses another user's execution plane via proxy | S | ⚠️ F-019 | `proxy.ts` queries `missions` by `{ missionId }` with no `userId` scope; any authenticated user who knows a `missionId` can proxy into that mission's MonitorServer and issue control commands |
| WireGuard traffic interceptable within Fly org | I | ~ | WireGuard encrypts in transit; peers in same org share the mesh — acceptable for single-org deployment |

---

## OWASP LLM Top 10 Threat Table

`✅` = mitigated; `⚠️` = open finding; `~` = partially mitigated; `A` = accepted.

| OWASP ID | Name | MAGI relevance | Status | Notes |
|----------|------|----------------|--------|-------|
| **LLM01** | Prompt Injection | Untrusted content (web pages, news articles, mailbox bodies, SKILL.md descriptions) enters LLM context and may override agent instructions | ~ | BrowseWeb wraps output in trust boundary markers; FetchUrl and SearchWeb injected as plain markdown. Role-focused system prompts are the only defence once content is in context. |
| **LLM02** | Insecure Output Handling | LLM output drives: Bash commands, WriteFile paths, JobSpec `scriptPath`, schedule labels, PostMessage recipients | ~ | AclPolicy constrains file paths. `scriptPath` validated against `permittedPaths`. Schedule label type guard added (F-005). PostMessage recipient validated against team roster. Bash unconstrained within `linuxUser` — OS ACLs are the backstop. |
| **LLM06** | Sensitive Information Disclosure | System prompt contains role, mental map (may include financial observations), skills block. Full conversation transmitted to OpenRouter when non-Anthropic models are used. | ~ | No credentials in system prompt. **OpenRouter risk:** financial mission context sent to third-party proxy with separate data-retention policy when `MODEL` or `VISION_MODEL` contains `/`. |
| **LLM07** | System Prompt Leakage | Injected instruction asks agent to include system prompt content in a FetchUrl URL, leaking role constraints and mental map. | ~ | PostMessage recipients restricted to team roster (no external exfiltration via mailbox). FetchUrl to attacker-controlled URL could exfiltrate if agent is tricked. No hard mitigation beyond prompt design. |
| **LLM08** | Excessive Agency | Agents have broad capabilities: Bash (arbitrary shell), WriteFile, EditFile, PostMessage, Research, FetchUrl, BrowseWeb, scheduled jobs. Concurrent execution (Sprint 17) amplifies cost exposure. | ~ | OS ACLs limit blast radius to agent's workdir + sharedDir. `MAX_COST_USD` caps spending, but `waitForBudget()` gates each *dispatch* — with N agents running concurrently, overshoot can be N × (one LLM call cost) before the pause fires. No per-session job-submission count limit. `RESEARCH_MAX_TURNS=10` limits Research sub-loop depth. |
| **LLM09** | Overreliance | Agents read data factory outputs without independently verifying freshness. Stale/corrupted data leads to incorrect recommendations. | ~ | `catalog.json` tracks `fetched_at` and `status`. Consumer SKILL.md instructs checking status before use. No enforcement — agents can ignore stale flags. |
