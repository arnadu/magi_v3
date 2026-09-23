# MAGI V3 Roadmap

## Objective

Build an autonomous multi-agent system where teams of AI agents run long-horizon missions — writing
and running code, browsing the web, processing data, coordinating with teammates, and publishing
work products. Primary use case: an equity research team producing daily market briefs, weekly
sector reports, and event-driven alerts with full citation lineage.

This file tracks sprint status and what's next, one line per sprint. For the full build log
(what was built, key files, design rationale, incident writeups) see
[docs/implementation-history.md](docs/implementation-history.md) — every sprint below with
detail worth reading has a matching section there. ADRs in `docs/adr/` hold individual
architectural decisions.

---

## Status

**MVP milestone hit at Sprint 27** (cockpit UI consolidation). Sprints 0–28e are done — 28e was
re-scoped 2026-09-17 to isolate the two closable **High**-severity security findings from the
2026-08-09 audit (CR-03, CR-04's job-env half) from the rest of the original 28e bucket, which is
genuinely lower-urgency and deferred to **28f** (not started), to be weighed against feature work
rather than treated as a security blocker. Sprint 29 (sensitive-data encryption + the harder,
per-tenant-credential half of CR-04) is planned but not started, and needs its own research pass
before implementation.

---

## Sprint History

| Sprint | Status | Summary |
|--------|--------|---------|
| 0 | ✅ | Architecture freeze — 6 ADRs: orchestration, agent loop, Mental Map, tool ACL, image handling, mailbox |
| 1 | ✅ | Inner loop — `runInnerLoop`, Bash/WriteFile/EditFile, MongoDB persistence, CLI, integration test |
| 2 | ✅ | Multi-agent — Zod team YAML, mailbox (PostMessage/ListMessages/ReadMessage), orchestration loop, supervisor-depth ordering |
| 3 | ✅ | Web tools — FetchUrl (HTML+PDF), InspectImage, SearchWeb (Brave); artifact folder model; `@path` uploads |
| 4 | ✅ | Identity + workspace — Linux pool users, `setfacl` ACLs, AclPolicy, WorkspaceManager, tool-executor subprocess isolation |
| 5 | ✅ | Agent skills — platform skills (skill-creator, git-provenance, inter-agent-comms); skill discovery; sharedDir git init |
| 6 | ✅ | Persistent daemon — MongoDB Change Stream sleep, conversation persistence (ADR-0008), scheduled_messages, cli:post/cli:tail |
| 7 | ✅ | BrowseWeb — Stagehand/Playwright JS rendering, session persistence, SSRF blocking |
| 8 | ✅ | Equity research MVP — 4-agent gold-digest team, schedule-task skill, daily brief + performance tracker |
| 9 | ✅ | Context management — session-boundary compaction, reflection (ADR-0009), llmCallLog, cli:usage |
| 10 | ✅ | Research tool — nested inner loop, isolated context, shared research index (ADR-0010) |
| 11 | ✅ | Dashboard UX — sessions tree, budget pause, mental map iframe, workspace persistence, cli:reset |
| 12 | ✅ | Data factory — secondary vision model, Tool IPC server (:4001), background jobs (ADR-0011) |
| 13 | ✅ | Hardening — security review, threat model (TB-1–TB-8), findings.md, quality gates |
| 14 | ✅ | Cloud infrastructure — Fly.io execution/control plane, proxy, scheduler, bootstrap.sh (ADR-0013) |
| 15 | ✅ | Developer onboarding — bootstrap.sh UX, .dockerignore, daemon log viewer, CI quality gate |
| 16 | ✅ | Model selection + templates — OpenRouter multi-LLM (ADR-0012), F-002 SSRF fix, MongoDB templates |
| 17 | ✅ | Concurrent dispatcher — fire-and-forget concurrent agent dispatch, `maxRuns`, `isAgentPaused` |
| 18 | ✅ | Dashboard UI rewrite — chat-app thread list, file browser, schedule/log/stats tabs, concurrent tracking |
| 19 | ✅ | Copilot agent — privileged control-plane assistant, 9 elevated tools, `ProposeAction` confirmation model |
| 20 | ✅ | Control plane UX — Unified Config Editor, home screen with live session cards, quick launch, skill toggles |
| 21 | ✅ | In-session context management — ephemeral tool-result pruning, thinking-block stripping, `AnalyzeMemories` recovery tool, extended thinking |
| 22 | ✅ | Copilot unification — `runAgent` for the copilot too; config-driven Tier A/B tool library, per-agent `disabledTools` |
| 23 | ✅ | **Auth + multi-user** — Firebase Auth, per-user mission scoping, per-user copilot daemons, `MONITOR_TOKEN` auth; closed F-008/009/016/019/020 |
| 24 | ✅ | **Budget hardening + alignment signals** — `StatsCollector` three-layer stats, `LimitRule` framework, OpenRouter live pricing, copilot `PauseAgent`/`ResumeAgent`/`SetMissionBudget` |
| 25 | ✅ | **File I/O + artifacts** — git-commit-on-sleep, shared `document-processor.ts`, upload/download pipeline |
| 26a | ✅ | Outcome-oriented cockpit spine — file-based `objectives` skill (tree/tasks/KPIs/budget), automatic cost attribution; superseded by 26c's MongoDB migration |
| 26b | ✅ | Cockpit SPA shipped — Objectives/Conversations/Transcripts/Files/Trace panels; cost-tracking (ADR-0017) and limit-config (ADR-0018) single-source-of-truth rewrites |
| 26c | ✅ | Closed the 24–26 alignment arc — persisted anomaly log (ADR-0020), structured mission config storage (ADR-0021), objectives → MongoDB (ADR-0019), config-editing scope (ADR-0022), OpenRouter real-cost (ADR-0023) + cache-efficiency (ADR-0024) |
| 27 | ✅ | **UI consolidation — MVP milestone.** Cockpit reaches feature parity, legacy `index.html` retired; conversation-recovery + model-switch guard (ADR-0025); copilot visibility panel (ADR-0027) |
| 28a | ✅ | Reliability fixes from 3 weeks of live usage — [#38](https://github.com/arnadu/magi_v3/issues/38)/[#41](https://github.com/arnadu/magi_v3/issues/41)/[#37](https://github.com/arnadu/magi_v3/issues/37)/[#40](https://github.com/arnadu/magi_v3/issues/40)/[#30](https://github.com/arnadu/magi_v3/issues/30)/[#25](https://github.com/arnadu/magi_v3/issues/25), F-024; [#31](https://github.com/arnadu/magi_v3/issues/31) (OOM investigation) stayed open |
| 28b | ✅ | Mission-prep v1 (draft/launch flow) + a fully separate beta deployment for a second, trusted user |
| 28c | ✅ (except CR-05) | CR-01/CR-02 security fixes; structural decomposition of `monitor-server.ts`/`daemon.ts` ([#32](https://github.com/arnadu/magi_v3/issues/32)/[#33](https://github.com/arnadu/magi_v3/issues/33), ADR-0029/ADR-0030) |
| 28d | ✅ | Live-bug fixes from mission-copilot reports — [#49](https://github.com/arnadu/magi_v3/issues/49) spend-cap ceiling (F-025 fixed), [#46](https://github.com/arnadu/magi_v3/issues/46) crash handlers, [#48](https://github.com/arnadu/magi_v3/issues/48) mid-turn dispatch gap, [#52](https://github.com/arnadu/magi_v3/issues/52) |
| 28e | ✅ | **Critical security fixes — the two pieces closable without a multi-tenant credential redesign.** **CR-03/F-002** (BrowseWeb SSRF, reopened a second time after Stagehand V3 removed the interceptor the threat model assumed still existed) fixed via a loopback egress-filtering proxy in front of Chromium, checking every request the browser makes, not just top-level navigation — caught and fixed two real bugs empirically along the way (Chromium's implicit loopback proxy-bypass; a CONNECT-tunnel socket leak that hung teardown indefinitely). **CR-04/F-030, job-env half** (background jobs got the raw `FRED_API_KEY`/`FMP_API_KEY`/`NEWSAPIORG_API_KEY` in their env, no privilege escalation needed) fixed via the same scoped-proxy pattern — job code now gets a capability through the existing ToolApiServer, never the reusable key. Both were High severity and live today, not preventive hardening. |
| **28f** | ⬜ **Next** | **Remaining operational hardening — nice-to-have, arbitrate against feature work.** G-5 out-of-band alerting ([#3](https://github.com/arnadu/magi_v3/issues/3)/[#4](https://github.com/arnadu/magi_v3/issues/4)) — G-4 disk monitoring itself closed in 28g; onboarding flow; usage dashboard; CR-06 (CI/CD supply chain), CR-07 remainder (confirmation gates for pause/resume/schedule-cancel — the acute spend-cap case is already fixed, 28d), CR-08 (sensitive-data posture, blocked on Sprint 29 anyway); [#7](https://github.com/arnadu/magi_v3/issues/7)/[#21](https://github.com/arnadu/magi_v3/issues/21); revisit [#31](https://github.com/arnadu/magi_v3/issues/31) (OOM) now that 28g's `oom-suspected` detection exists (not yet live-verified against a genuine Fly-level OOM kill); unblocks F-021/F-023/F-026 |
| **28g** | ✅ | **Resource management** — temporary mission-machine upgrades ([ADR-0031](docs/adr/0031-temporary-resource-upgrades-vm-cost.md): any agent asks, the mission-copilot decides; ≤ 60 min windows, 24 h cumulative cap with operator reset in the Limits panel, runtime-by-config cockpit tab) and proactive resource oversight ([ADR-0032](docs/adr/0032-proactive-resource-oversight.md): daily report + nine anomaly categories, Change-Stream copilot waker). Closes **G-4** and the Atlas-storage gap. Live-verified end to end on dev: full upgrade/revert cycle, a real disk-fill test (soft + hard thresholds), an independently-recomputed Atlas storage figure, and a real daily-report send with an organically-occurring flag. `oom-suspected` detection shipped but not live-verified (no genuine Fly-level OOM kill occurred during testing) — [#31](https://github.com/arnadu/magi_v3/issues/31) stays open pending that. Full build log and step-by-step live-verification detail: [docs/plans/resource-management-implementation-plan.md](docs/plans/resource-management-implementation-plan.md). |
| 29 | ⬜ Planned | **Sensitive-data encryption + tenant credential isolation** — direction recorded in [ADR-0026](docs/adr/0026-sensitive-data-encryption-direction.md); needs a dedicated research pass (KMS choice, key custody, migration path) before implementation. Now also scoped to absorb **CR-04's harder half**: every mission machine currently gets the same cluster-wide `MONGODB_URI`/LLM API keys, so any full machine compromise (not just the CR-01 privilege-escalation path, already closed) exposes every other tenant's data — the real fix is per-tenant database isolation or a scoped Mongo/LLM gateway, not something to bolt on superficially alongside 28e's contained fixes. |

---

## Operational resilience gaps

Tracked in [docs/operational-resilience.md](docs/operational-resilience.md), not duplicated here.
Currently open: **G-5** (out-of-band alerting, 🟠, candidate 28f), **G-2** (inbox two-phase ack, 🟠,
live-hit 2026-09-22 during 28g's own testing — see `docs/operational-resilience.md`), **G-8** (no
MongoDB backup/PITR on the free Atlas tier, 🔴, accepted for now pre-revenue), **G-9**
(`conversationMessages` unbounded growth, 🔴, tracked as issue #54), **G-11**/**G-12** (small
copilot-daemon/resize-recovery gaps from 28g, both 🟠). **G-4** (disk monitoring) closed in 28g.

---

## Near-term candidates (not yet sequenced)

Sized up but not yet assigned a sprint number — candidates for right after 28f, ahead of the
general Post-MVP backlog below.

| Item | Notes |
|------|-------|
| Interactive service exposure (Jupyter, other web apps on a mission machine) | Issue [#42](https://github.com/arnadu/magi_v3/issues/42), filed by the mission-copilot on `meteo-textbook-20260730`. Path-based reverse proxy through the existing monitor-server connection (reuses the CR-03 egress-proxy's raw-socket-tunneling technique), config-declared allowed ports (not agent-openable at runtime) — needs its own ADR before implementation. |

---

## Post-MVP (after Sprint 27)

| Item | Notes |
|------|-------|
| Multi-tenant + billing | Per-user API key (BYOK); usage-based billing; tenant isolation beyond shared system key |
| Evaluation harness | Golden scenarios for structural/policy outcomes; CI regression suite ([#45](https://github.com/arnadu/magi_v3/issues/45)) |
| Mission builder UI | Guided copilot flow + form-based config; `DestroyMission` tool |
| `ProcessMore(artifactId)` tool | Resume document processing past the automatic limit (PDF pages beyond vision cap, nested ZIPs, chart-only sheets) |
| RAG facility | MongoDB Atlas Vector Search (`$vectorSearch`); deferred until a mission demonstrably exhausts context on its own collected data |
| Generic operator-managed secret registry | Lets a skill call any key-protected external API without the raw key ever reaching agent-authored code — generalizes 28e's CR-04 job-env proxy fix (scoped local proxy, no reusable credential in the job's env) from three hardcoded data-provider keys to an operator-editable, named-secret registry. Sequenced after Sprint 29: storing arbitrary operator secrets in MongoDB raises the same at-rest-encryption question Sprint 29 already has to answer, so this reuses that answer rather than inventing a second one. |
| Extract-before-destroy | Push git history to remote or extract to MongoDB before `destroyMission` deletes the volume, if audit requirements arise |
| Interactive HTML preview in Files | Sandboxed `<iframe srcdoc sandbox="allow-scripts">` for agent-authored dashboards — full design: [docs/implementation-history.md](docs/implementation-history.md), "Deferred design — Interactive HTML preview in Files" |

---

## Reference

The original sprint-by-sprint pre-implementation plans (including rejected designs for Temporal,
Redis, MinIO, and MockLLMProvider) are preserved at
[docs/discarded/sprint-plans.md](docs/discarded/sprint-plans.md).
