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

---

## Future Sprints

| Sprint | Status | Candidate focus |
|--------|--------|----------------|
| 17 | ⬜ Planned | Firebase Auth + per-user mission isolation on control plane |
| 18 | ⬜ Planned | Mental map compaction (size-bounded; reflection-time pruning) |
| 19 | ⬜ Planned | React / Next.js frontend on Vercel; file browser API |
| 20+ | ⬜ Future | Copilot agent (chat interface); multi-tenant; evaluation harness |

---

## Reference

The original sprint-by-sprint pre-implementation plans (including rejected designs for Temporal,
Redis, MinIO, and MockLLMProvider) are preserved at
[docs/discarded/sprint-plans.md](docs/discarded/sprint-plans.md).
