# MAGI V3 Roadmap

## Objective

Build an autonomous multi-agent system where teams of AI agents run long-horizon missions — writing
and running code, browsing the web, processing data, coordinating with teammates, and publishing
work products. Primary use case: an equity research team producing daily market briefs, weekly
sector reports, and event-driven alerts with full citation lineage.

---

## Sprint History

| Sprint | Status | Focus | Key decisions |
|--------|--------|-------|---------------|
| 0 | ✅ Done | Architecture freeze | 6 ADRs: orchestration, agent loop, Mental Map, tool ACL, image handling, mailbox |
| 1 | ✅ Done | Inner loop | `runInnerLoop`, Bash/WriteFile/EditFile, MongoDB persistence, CLI, integration test |
| 2 | ✅ Done | Multi-agent | Zod team YAML, mailbox (PostMessage/ListMessages/ReadMessage), orchestration loop, supervisor-depth ordering |
| 3 | ✅ Done | Web tools | FetchUrl (HTML+PDF), InspectImage, SearchWeb (Brave); artifact folder model; `@path` uploads |
| 4 | ✅ Done | Identity + workspace | Linux pool users, `setfacl` ACLs, AclPolicy, WorkspaceManager, tool-executor subprocess isolation |
| 5 | ✅ Done | Agent skills | Platform skills (skill-creator, git-provenance, inter-agent-comms); skill discovery; sharedDir git init |
| 6 | ✅ Done | Persistent daemon | MongoDB Change Stream sleep, conversation persistence (ADR-0008), scheduled_messages, cli:post/cli:tail |
| 7 | ✅ Done | BrowseWeb | Stagehand/Playwright JS rendering, session persistence, SSRF blocking (ADR included in ADR-0007) |
| 8 | ✅ Done | Equity research MVP | 4-agent gold-digest team, schedule-task skill, daily brief + performance tracker |
| 9 | ✅ Done | Context management | Session-boundary compaction, reflection (ADR-0009), llmCallLog, cli:usage |
| 10 | ✅ Done | Research tool | Nested inner loop, isolated context, shared research index (ADR-0010) |
| 11 | ✅ Done | Dashboard UX | Sessions tree, budget pause, mental map iframe, workspace persistence, cli:reset |
| 12 | ✅ Done | Data factory | Secondary vision model, Tool IPC server (:4001), background jobs, data-factory skill (ADR-0011) |
| 13 | ✅ Done | Hardening | Security review, threat model (TB-1–TB-8), findings.md, quality gates |
| 14 | ✅ Done | Cloud infrastructure | Fly.io execution/control plane, proxy, scheduler, bootstrap.sh (ADR-0013) |
| 15 | ✅ Done | Developer onboarding | bootstrap.sh UX, .dockerignore, daemon log viewer, test config relocation, CI quality gate |
| 16 | ✅ Done | Model selection + templates | OpenRouter multi-LLM (ADR-0012), F-002 SSRF fix, agent-error SSE, MongoDB templates + provision-time injection, non-blocking resume, SHARED_DIR in subprocess env |
| 17 | ✅ Done | Concurrent dispatcher | Fire-and-forget concurrent agent dispatch (replaces sequential loop), `maxRuns`, `isAgentPaused`, F-017 verifyIsolation for OPENROUTER_API_KEY, threat model refresh |
| 18 | ✅ Done | Dashboard UI rewrite | Chat-app thread list + markdown bubbles + file browser + schedule/log/stats tabs; concurrent agent tracking; Kill button; Playbook removed |
| 19 | ✅ Done | Copilot agent | Privileged assistant in control plane: magi-copilot OS user, `runInnerLoop` wiring, 9 elevated tools (ListMissions/GetMissionStatus/ReadMissionMailbox/ReadMissionLog/ReadMissionFile/ListSchedule/ListTemplates/GetTemplate + ProposeAction confirmation model), Change Stream wakeup, execution-plane alert routing, chat panel in control plane UI |
| 20 | ✅ Done | Control plane UX (extended) | Three-column sidebar (Sprint 20 base); Unified Config Editor (structured form, CodeMirror mental map, 30s poll protection); home screen with live session cards (unread/spend/activity stats); quick launch from template; agent active toggle + add/remove agent; skill toggles (disabledSkills[]); session dual save bar + save-as-template; G-1 restart policy; `active`/`disabledSkills` schema; stats endpoint; inline YAML at launch; copilot `save_session_config` |

---

## MVP Sprints (23–27)

| Sprint | Status | Candidate focus |
|--------|--------|----------------|
| 21 | ✅ Done | Context management (in-session): ephemeral tool-result pruning (`EPHEMERAL_TOOLS`, `pruneEphemeralResults`), thinking-block stripping, mid-session prune at 160k tokens, `AnalyzeMemories` tool, extended thinking enabled on `CLAUDE_SONNET` (`reasoning: "medium"`) |
| 22 | ✅ Done | Copilot unification + config-driven tool library: copilot calls `runAgent` via `additionalTools` hook; `disabledTools` per-agent YAML; Tier A/B tool library; `LlmCallLogRepository` exported |
| 23 | ✅ Done | **Auth + multi-user**: Firebase Auth (Google OAuth); `userId` on missions; per-user mission scoping; one copilot daemon per Firebase UID (`copilot-{uid}`); `/api/usage` per-user and admin; `magi_session` cookie for new-tab auth (dashboard); org-level `FLY_API_TOKEN_CI`; 512 MB control plane VM; structured error logging + `errorMessage` in MongoDB; `MONITOR_TOKEN` HMAC auth on MonitorServer (`MONITOR_SIGNING_KEY`); fix F-008/F-009/F-016/F-019/F-020 |
| 24 | ⬜ Planned | **Budget hardening + resilience**: hard per-mission spend cap enforced at LLM call time; dashboard budget controls; copilot `GetBudget`/`SetBudget` tools; G-3 missed cron replay on daemon restart; G-2 two-phase inbox ack |
| 25 | ⬜ Planned | **File I/O**: upload files to mission sharedDir (multipart endpoint + drag-drop in dashboard); download artifacts (serve from mission dir + download button in file browser); G-4 disk usage in stats tab |
| 26 | ⬜ Planned | **Unified UX + rich artifacts**: in-app mission drill-down (execution plane iframe panel within control plane layout); shared nav bar with breadcrumbs; Mermaid diagram rendering; KaTeX equations; inline image preview; Markdown report viewer |
| 27 | ⬜ Planned | **Launch hardening**: G-5 out-of-band alerting (webhook/email on agent-error); onboarding flow (first-login wizard); usage dashboard (per-user spend history); full `/security-review` pass; deployment documentation update |

### Operational resilience gaps (from `docs/operational-resilience.md`)

These are backlog candidates — pick them up in priority order as sprint capacity allows.

| Gap | Severity if triggered | Fix complexity | Candidate sprint |
|-----|-----------------------|----------------|-----------------|
| ~~**G-1**~~ ~~No auto-restart policy on Fly execution machine~~ | ~~🟠 Mission stall~~ | **Closed Sprint 20** — `restart: { policy: "on-failure", max_retries: 3 }` added to `fly-machines.ts` | ✅ |
| **G-3** Missed cron fires not replayed on daemon restart — equity research daily brief silently skipped if daemon is down at fire time | 🔴 Data loss | Moderate — startup catch-up scan of `scheduled_messages` for past-due undelivered entries (~20 lines in `daemon.ts`) | **24** |
| ~~**G-6**~~ ~~Orphaned background jobs not cleaned on restart~~ | ~~🟠 Mission stall~~ | **Closed Sprint 12** — `recoverOrphanedJobs()` in `daemon.ts` | ✅ |
| **G-4** No disk monitoring for Fly Volume — volume fills silently, writes fail with no alert | 🔴 Data loss | Moderate — log disk usage in daemon heartbeat; surface in dashboard stats tab | **25** |
| **G-2** Inbox messages marked-read before agent completes — inbox text lost on crash in the narrow window between `markRead` and `runAgent` completion | 🟠 Mission stall | Moderate — two-phase read/ack in orchestrator (`processing` → `read` in `.finally()`) | **24** |
| **G-5** No out-of-band alerting for LLM auth failure / credits exhausted — operator must notice dashboard banner | 🟠 Mission stall | Moderate — POST to a webhook or send email on `agent-error` with `transient: false` | **27** |

---

## Post-MVP (after Sprint 27)

| Item | Notes |
|------|-------|
| React / Next.js frontend on Vercel | Full SPA rewrite; completes the control/execution plane unification started in Sprint 26; enables deep linking into agent threads |
| Multi-tenant + billing | Per-user API key (BYOK); usage-based billing; tenant isolation beyond shared system key |
| Evaluation harness | Golden scenarios for structural/policy outcomes; CI regression suite |
| Mission builder UI | Guided copilot flow + form-based config; `DestroyMission` tool |

---

## Reference

The original sprint-by-sprint pre-implementation plans (including rejected designs for Temporal,
Redis, MinIO, and MockLLMProvider) are preserved at
[docs/discarded/sprint-plans.md](docs/discarded/sprint-plans.md).
