---
name: magi-codebase
description: |
  Key source files for debugging MAGI missions and the control plane.
  Use when diagnosing errors, reading mission provisioning logic, or locating
  the right file before making a ProposeAction to change config or source.
---

# MAGI Codebase Layout

Source lives at `/app/packages/` in production and at `/home/remyh/ml/MAGI_V3/packages/`
in development. Use `find`, `cat`, and `grep` to read files as needed.

## agent-runtime-worker/src/

| File | Purpose |
|------|---------|
| `daemon.ts` | Persistent daemon — Change Stream wake-up, cron heartbeat, job runner |
| `orchestrator.ts` | `runOrchestrationLoop` — provisions workspace, dispatches agents, `maxRuns`, `isAgentPaused`, `active === false` skip |
| `agent-runner.ts` | `runAgent` — loads conversation history, builds system prompt, runs inner loop |
| `loop.ts` | `runInnerLoop` — LLM ↔ tool loop; `toolTimeoutMs`, `onLlmCall`, `maxTurns` |
| `tools.ts` | `Bash`, `WriteFile`, `EditFile` — isolated via `sudo -u <linuxUser> node tool-executor.js` |
| `monitor-server.ts` | HTTP + SSE dashboard on port 4000; all dashboard routes |
| `mailbox.ts` | `MailboxRepository` (MongoDB), `PostMessage`, `ListMessages`, `ReadMessage` |
| `prompt.ts` | `buildSystemPrompt` — substitutes placeholders, appends skills block |
| `skills.ts` | `discoverSkills(sharedDir, workdir)` — scans four tier dirs, parses SKILL.md frontmatter |
| `workspace-manager.ts` | `WorkspaceManager.provision` — creates workdirs, copies skills, `setfacl`, `git init` |
| `reflection.ts` | Session-boundary compaction + reflection LLM call |
| `conversation-repository.ts` | `conversationMessages` collection — load, append, compact, mental map |
| `llm-call-log.ts` | `llmCallLog` collection — cost tracking per LLM call |

## control-plane/src/

| File | Purpose |
|------|---------|
| `index.ts` | Express app entry; mounts all routers; starts copilot daemon if `COPILOT_MISSION_ID` set |
| `missions.ts` | Mission CRUD + lifecycle (`POST /`, `GET /stats`, suspend, resume, destroy) |
| `fly-machines.ts` | `provisionMission`, `suspendMission`, `resumeMission` — Fly Machines API client |
| `templates.ts` | Template CRUD (`GET`, `POST`, `PUT`) + `seedTemplates` on startup |
| `copilot-daemon.ts` | Copilot watch loop, `runCopilotTurn`, `provisionCopilotSkills` |
| `copilot-tools.ts` | Category B elevated tools (ListMissions … ProposeAction) |
| `copilot-router.ts` | `/api/copilot/message`, `/events` (SSE), `/confirm`, `/dismiss`; `executeAction` dispatcher |

## agent-config/src/

| File | Purpose |
|------|---------|
| `loader.ts` | `AgentSchema` (Zod) + `TeamConfig`; `loadTeamConfig(path)`, `parseTeamConfig(yaml)` |

## MongoDB collections

| Collection | Contents |
|---|---|
| `conversationMessages` | Full agent conversation history with compaction and reflection |
| `mailbox` | Inter-agent and operator messages |
| `llmCallLog` | Audit log of every LLM call with cost breakdown |
| `scheduled_messages` | Cron-based agent wakeups |
| `missions` | Mission records with status, machineId, teamConfigYaml |
| `templates` | Team config templates with teamFiles |
