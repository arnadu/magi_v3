# ADR-0029 — `monitor-server.ts`: strangler-fig route table over a class-method dispatch

**Status**: Accepted
**Sprint**: 28c (issue #32)
**Date**: 2026-09-14

---

## Context

An independent audit (2026-08-09) flagged `MonitorServer.handleRequest` as a god-function: 719
lines, 34 routes as a flat `if (url === "/x" && method === "Y") {...}` chain over raw `node:http`
(no Express), each branch closing over `this` for state (`db`, `agents`, `clients`, mutable
per-mission fields like `stepEnabled`/`budgetPaused`). See
`docs/code-review-audit-response-2026-08-12.md` and `docs/code-structure.md`. The file needed
decomposing without a rewrite — this dispatch has run in production since early sprints and
carries real behavioral subtlety (auth exemptions, SSE heartbeats, per-route body-size caps) that
a full rewrite risks silently changing.

Two shapes were considered for where the 34 routes should live:

1. **Minimal cut-and-paste into private methods** — each route becomes
   `private async handleFoo(req, res): Promise<void>`, still reading `this.x` directly, called
   from a dispatch table `{ "/foo": this.handleFoo }`. Smallest possible diff per route.
2. **One file per route cluster, each a factory function taking an explicit `deps` object** —
   `createFooRoutes(deps: FooDeps): RouteEntry[]`, matching the repo's own `src/tools/` precedent
   (one file per tool, factory-function style, ADR-precedent though not itself an ADR).

Option 1 is a smaller diff per commit but leaves every route still coupled to the full
`MonitorServer` instance — a cluster can't be unit-tested without constructing (or mocking) the
whole class, and `this.x` access hides exactly which fields a given route actually touches.
Option 2 costs a slightly larger diff (`this.x` → `deps.x` at every call site) but makes each
cluster's dependency surface an explicit, typed list, and each cluster becomes testable with a
small hand-built `deps` object — no HTTP server, no real Mongo for several clusters (dashboard
shell, static assets). Confirmed with the user directly (not assumed) before starting.

---

## Decision

**Strangler-fig migration, one route cluster per file, each a factory function over an explicit
`deps` object — not a rewrite of `handleRequest` in one pass.**

```ts
// src/monitor-routes/types.ts
export interface RequestCtx { req: IncomingMessage; res: ServerResponse; rawUrl: string; url: string; }
export interface RouteEntry {
  method: "GET" | "POST" | "DELETE";
  path: string | string[] | RegExp;
  handler: (ctx: RequestCtx, ...params: string[]) => Promise<void> | void;
}
```

`MonitorServer`'s constructor builds `this.routes` once, concatenating every migrated cluster's
`createXRoutes(deps)` output. `handleRequest` becomes, in its final state: CORS headers → the
existing global auth gate (`method !== "GET" && !tokenOk()` → 401 — this stays literally global,
checked once, never duplicated per-route) → a loop matching method+path against `this.routes` →
fallback 404. Until a cluster migrates, its routes stay word-for-word in the legacy `if`-chain
below the table — verified no two route patterns overlap, so table and legacy chain never
conflict, and every intermediate commit compiles, type-checks, and is independently deployable
(this repo treats `git push` to `main` as a deploy).

A field that's *replaced by reference* (e.g. `agentWorkdirs`, swapped out wholesale by
`setAgentWorkdirs()`) is passed into `deps` as a getter function (`getAgentWorkdirs: () =>
this.agentWorkdirs`), never by value — a `deps` object built once at cluster-construction time
would otherwise go stale the moment the field is reassigned. A field that's *mutated in place* by
the routes themselves (`stepResolve`, `stepEnabled`, `started`, `budgetPaused`, ...) needs an
explicit getter+setter accessor pair in the cluster's `Deps` interface for the same reason, since
the routes both read and write it and other, not-yet-migrated code (`statusPayload`, the
orchestrator's step-mode wiring) also depends on seeing the current value.

Logic still living in still-private `MonitorServer` methods (e.g. `serveFilePath`,
`handleFileEdit`, `handleUpload`) is passed into a cluster's `deps` as a bound callback rather
than moved — moving it would be a second, unrelated refactor riding on top of this one. Extraction
order is risk-ordered: clusters with existing test coverage or with logic already delegated to a
tested private helper go first (dashboard shell, static assets, file browsing); the largest chunk
of genuinely inline, untested logic (agent sessions/transcripts) goes once the pattern is proven;
`upload`/`download` go last, deleting the now-dead legacy chain and finalizing `handleRequest` as
pure dispatch in the same commit.

Each of the 15 resulting cluster files got new or extended integration test coverage — a real
MongoDB connection and a real `MonitorServer` instance on a free port, not mocks — landing in the
same commit as that cluster's extraction, verified with typecheck + lint + the full unit suite
before each commit.

---

## Consequences

- `handleRequest` goes from 719 lines to 36: auth gate + a route-table loop + 404 fallback. No
  single god-function remains in this file.
- 15 new files under `agent-runtime-worker/src/monitor-routes/`, each independently unit-testable
  via a hand-built `deps` object where its dependencies allow (dashboard shell, static assets,
  mailbox, log, pause/resume, run control, lifecycle, upload/download — none of these strictly
  need a live Mongo connection to construct their `deps`, though the shipped tests still exercise
  them against a real one for parity with the rest of the suite's convention).
- Previously-untested routes (static assets beyond `/`, `/log`, agent sessions/transcripts,
  `DELETE /schedule/:id`, all four trace/analytics routes, run control's SSE side effects,
  pause/resume, `/stop`) now have direct HTTP-level test coverage for the first time.
- Found and documented live, not fixed: `/events`'s handler only adds a client to the SSE
  broadcast set *after* an `await statusPayload()` (a real Mongo round trip) — a state-changing
  request fired immediately after opening the stream can race ahead of that registration and have
  its `push()` silently miss that one client. Pre-existing behavior since before this
  decomposition; left as-is per "extract, don't fix along the way" — noted in
  `monitor-run-control.integration.test.ts` so a future fix has the repro already written down.
- CR-05 (auth token handling) is explicitly deferred until after this decomposition, so it lands
  once inside the new route-table structure rather than twice (once in the old chain, once in the
  new table).

---

## Related

- `packages/agent-runtime-worker/src/monitor-server.ts` — `handleRequest`, `this.routes`
  construction
- `packages/agent-runtime-worker/src/monitor-routes/` — all 15 cluster files + `types.ts`
- `packages/agent-runtime-worker/tests/monitor-*.integration.test.ts` — one file per cluster,
  landed alongside that cluster's extraction commit
- `docs/code-structure.md` — the file's inventory row, decomposition status
- `docs/code-review-audit-report-2026-08-09.md` / `docs/code-review-audit-response-2026-08-12.md`
  — the audit that flagged this file
- GitHub issue #32 (closed)
- ADR-0030 — the twinned decomposition of `daemon.ts`'s `main()`, same sprint
