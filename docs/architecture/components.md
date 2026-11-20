<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Components

**Approved 2026-11-19.** The architecture baseline: the components MAGI is built from, each with its layer, its responsibility and the source paths it owns. A component builds on components of lower layers in its plane, and on `config`; an import of the same or a higher layer runs against the layering. The product baseline ([../product/](../product/README.md)) says what MAGI does; this says how it is built. Each operation's home lies in exactly one component. Every source file under a root belongs to exactly one component (tests excluded): `dir/` owns a directory, `**` the whole root, anything else is a glob on the path under the root.

## Control plane

| Id | Component | Layer | Responsibility | Root | Paths |
|---|---|---|---|---|---|
| `cp-host` | Process host | 6 | Start-up, database, process guards | `packages/control-plane/src` | `index.ts`, `mongo.ts`, `process-guards.ts`, `types.d.ts` |
| `cp-mc-gateway` | Mission-copilot gateway | 5 | What a mission copilot may ask the control plane for | `packages/control-plane/src` | `mission-copilot-router.ts` |
| `cp-copilot` | Control copilot | 4 | Its loop, tools, proposals and their execution, visibility | `packages/control-plane/src` | `copilot-*`, `pending-actions.ts`, `github*.ts` |
| `cp-api` | Mission API | 3 | The operator's routes: missions, drafts, config, limits, reads | `packages/control-plane/src` | `mission-routes-*`, `missions.ts`, `mission-drafts.ts`, `mission-scope.ts`, `mission-status.ts`, `mission-resource-routes.ts`, `catalog-routes.ts`, `platform-routes.ts`, `public-routes.ts`, `templates.ts`, `config-version.ts`, `async-handler.ts` |
| `cp-mission-ops` | Mission operations | 2 | The homes of mission operations: lifecycle, launch claims, limits, spend | `packages/control-plane/src` | `mission-lifecycle-actions.ts`, `mission-claims.ts`, `mission-limits.ts`, `mission-spend.ts`, `spend-policy.ts`, `mission-stats-summary.ts` |
| `cp-scheduler` | Scheduler | 2 | Delivering due schedules | `packages/control-plane/src` | `scheduler.ts` |
| `cp-edge` | Edge and identity | 2 | Sign-in, sessions, users, security headers, the proxy to mission machines, monitor tokens | `packages/control-plane/src` | `auth*.ts`, `session-routes.ts`, `firebase.ts`, `users.ts`, `security-headers.ts`, `proxy.ts`, `monitor-token.ts` |
| `cp-machines` | Machine lifecycle | 1 | Fly machines and volumes: provision, wake, resize, upgrade, segments | `packages/control-plane/src` | `machine-*`, `fly-*`, `resource-upgrade*` |
| `cp-oversight` | Resource oversight | 1 | Sampling, alerts, the daily report, platform relays | `packages/control-plane/src` | `resource-monitor.ts`, `resource-alerts.ts`, `resource-queries.ts`, `resource-report*`, `atlas-usage.ts`, `usage-queries.ts`, `platform-relay.ts`, `mailbox-writer.ts` |
| `cp-records` | Mission records | 1 | Reads of what agents and copilots did (turns, transcripts, model calls), served from the database so they work while a mission's machine is stopped | `packages/control-plane/src` | `transcript-queries.ts` |

## Mission machine

| Id | Component | Layer | Responsibility | Root | Paths |
|---|---|---|---|---|---|
| `mm-cli` | Developer CLI | 6 | Local commands | `packages/agent-runtime-worker/src` | `cli*.ts`, `user-input.ts`, `index.ts` |
| `mm-daemon` | Daemon | 5 | Boot, orchestration, dispatch | `packages/agent-runtime-worker/src` | `daemon.ts`, `daemon-boot/`, `orchestrator*`, `exit-on-fatal.ts`, `node-polyfill.ts` |
| `mm-mission-copilot` | Mission copilot | 4 | Its tools and their checks | `packages/agent-runtime-worker/src` | `mission-copilot*`, `resource-upgrade-tool.ts` |
| `mm-monitor` | Monitor server | 4 | The cockpit-facing routes on the mission machine (port 4000) | `packages/agent-runtime-worker/src` | `monitor-*`, `monitor-routes/` |
| `mm-jobs` | Jobs and schedules | 4 | Background jobs, the Tool API (port 4001), schedule ingestion | `packages/agent-runtime-worker/src` | `job-*`, `tool-api-server.ts`, `schedule-ingest.ts` |
| `mm-agent-loop` | Agent loop | 3 | A turn: prompt, LLM calls, tools, limits, reflection, logging | `packages/agent-runtime-worker/src` | `agent-runner*`, `loop*.ts`, `prompt.ts`, `prompts.ts`, `reflection.ts`, `context-utils.ts`, `limits.ts`, `llm-*`, `models.ts`, `openrouter-pricing.ts`, `retry-backoff.ts`, `agent-stats.ts`, `usage.ts`, `mental-map*`, `skills.ts` |
| `mm-tools` | Agent tools | 2 | The tools agents call and their isolated execution | `packages/agent-runtime-worker/src` | `tools/`, `tools.ts`, `tool-catalog.ts`, `tool-args.ts`, `tool-executor.ts`, `images/`, `document-*`, `pdf-*`, `ocr-cap.ts`, `mime-types.ts`, `artifacts.ts` |
| `mm-state` | Mission state | 1 | Mailbox, conversations, config, objectives, stats, anomalies, resources | `packages/agent-runtime-worker/src` | `mailbox.ts`, `conversation-repository.ts`, `mission-config*`, `objectives/`, `anomaly*`, `resource-alert-state.ts`, `resource-sampler.ts`, `resource-thresholds.ts`, `mongo.ts` |
| `mm-isolation` | Isolation and mission files | 1 | OS users, workspaces, git, safe paths and HTTP; reading and writing the mission's files within their folders | `packages/agent-runtime-worker/src` | `linux-user.ts`, `workspace-*`, `safe-*`, `ssrf.ts`, `remove-if-exists.ts` |

## Cockpit (in the browser)

| Id | Component | Layer | Responsibility | Root | Paths |
|---|---|---|---|---|---|
| `ui-shell` | Cockpit shell | 3 | Sign-in, header, navigation between missions and their tabs, the home view | `packages/cockpit/src` | `main.tsx`, `App.tsx`, `Header.tsx`, `TabBar.tsx`, `HomeView.tsx`, `LoginScreen.tsx`, `SignOutButton.tsx`, `MissionDashboard.tsx`, `auth.ts`, `app-hooks.ts`, `styles.css`, `vite-env.d.ts` |
| `ui-missions` | Missions and drafts | 2 | The mission list, templates, creating and editing drafts, launching, suspending and resuming | `packages/cockpit/src` | `MissionsPanel.tsx`, `TemplatesPanel.tsx`, `Draft*.tsx`, `use-draft-*`, `mission-status-action.ts` |
| `ui-config` | Mission configuration | 2 | Editing a mission's settings, agents, skills, tools, image settings and mental maps | `packages/cockpit/src` | `Config*.tsx`, `AgentToggles.tsx`, `MentalMap*.tsx`, `ImageSettingsFields.tsx`, `image-settings.ts`, `mental-map-diff.ts`, `available-skills.ts`, `use-catalog.ts`, `use-mission-config-editor.ts` |
| `ui-activity` | Mission activity | 2 | What the agents did: conversations, transcripts, model calls, the trace timeline, the log, agent errors | `packages/cockpit/src` | `ConversationsPanel.tsx`, `conversations/`, `TranscriptsPanel.tsx`, `transcripts/`, `TracePanel.tsx`, `trace/`, `LogPanel.tsx`, `AgentErrorBanner.tsx`, `call-index.ts`, `llm-call-types.ts` |
| `ui-files` | Mission files | 2 | Browsing, viewing, uploading and editing the mission's files | `packages/cockpit/src` | `FilesPanel.tsx`, `use-file-node.ts` |
| `ui-objectives` | Objectives | 2 | The objective tree, tasks and KPIs, and their progress | `packages/cockpit/src` | `ObjectivesPanel.tsx`, `types.ts` |
| `ui-limits` | Spend, limits and schedules | 2 | Spend against cap and ceiling, agent limits, machine runtime and upgrades, schedules | `packages/cockpit/src` | `LimitsPanel.tsx`, `RuntimePanel.tsx`, `UpgradeLimitsSection.tsx`, `SchedulePanel.tsx`, `mission-spend.ts` |
| `ui-copilot` | Copilot panel | 2 | Talking to the copilot, confirming its proposals, its transcripts, files, limits and settings | `packages/cockpit/src` | `Copilot*.tsx`, `copilot/` |
| `ui-api` | Cockpit API client | 1 | Every call from the cockpit to the control plane, and the polling around them | `packages/cockpit/src` | `api/`, `data.ts`, `use-api-resource.ts`, `use-visible-poll.ts` |
| `ui-kit` | Cockpit building blocks | 1 | Shared display pieces: Markdown, JSON trees, loading and error states, the resizable message box | `packages/cockpit/src` | `Markdown.tsx`, `markdown.ts`, `JsonTree.tsx`, `LoadingView.tsx`, `load-error.tsx`, `InputResizeGrip.tsx`, `use-input-resize.ts` |

## Shared

| Id | Component | Layer | Responsibility | Root | Paths |
|---|---|---|---|---|---|
| `config` | Configuration and stored types | 0 | Team-config schema, stored document types, collections, model defaults, the env catalogue, the baselines | `packages/agent-config/src` | `**` |
| `skills` | Platform skills | 0 | Skills shipped to every mission | `packages/skills` | `**` |

## Data stores

Each MongoDB collection, what it holds and the one component whose code writes it. A write from any other component is a finding unless it is listed as an exception. The owner is the component, not the process.

| Collection | Holds | Owner | Also written by |
|---|---|---|---|
| `missions` | mission | `cp-mission-ops` | `cp-machines` (the machine, volume and machine shape) |
| `missionConfigRevisions` | Each saved revision of a mission's configuration | `cp-mission-ops` |  |
| `users` | Signed-in users | `cp-edge` |  |
| `scheduledMessages` | schedule | `cp-scheduler` |  |
| `mailbox` | message | `mm-state` |  |
| `conversationMessages` | turn (its messages, step by step) | `mm-state` |  |
| `llmCallLog` | llm-call | `mm-agent-loop` | `cp-scheduler` (retention pruning) |
| `agentTurnStats` | turn (its statistics) | `mm-agent-loop` |  |
| `missionStats` | Lifetime totals per agent | `mm-agent-loop` |  |
| `missionAnomalies` | Anomalies: crashes, timeouts, failed deliveries, resource alerts | `mm-state` | `cp-oversight` (anomalies the control plane detects) |
| `objectivesGoals` | objective | `mm-state` |  |
| `objectivesEvents` | task (and KPI, cost and allocation events) | `mm-state` |  |
| `missionResources` | The latest resource sample of each mission | `mm-state` |  |
| `platformResources` | Platform-wide resource samples (database storage) | `cp-oversight` |  |
| `resourceAlertState` | Which resource alerts are raised, for de-duplication | `mm-state` |  |
| `resourceSnapshots` | One daily resource report per user | `cp-oversight` |  |
| `machineSegments` | Each stretch a mission's machine ran with one shape | `cp-machines` |  |
| `copilotPendingActions` | pending-action | `cp-copilot` |  |

## External systems

| Id | System | Used for | Reached by |
|---|---|---|---|
| `mongodb` | MongoDB Atlas | All persistent state (the data stores above) | `cp-mission-ops`, `cp-machines`, `cp-scheduler`, `cp-oversight`, `cp-records`, `cp-copilot`, `cp-edge`, `cp-api`, `mm-state`, `mm-agent-loop`, `mm-daemon`, `mm-monitor`, `mm-mission-copilot`, `mm-jobs` |
| `fly` | Fly.io Machines API | Mission machines and volumes | `cp-machines` |
| `llm-providers` | Anthropic and OpenRouter | Model calls and image generation | `mm-agent-loop`, `mm-tools`, `cp-copilot` |
| `github` | GitHub API | Issues about MAGI | `cp-copilot` |
| `firebase` | Firebase Authentication | Signing operators in | `cp-edge`, `ui-shell` |
| `web` | The web (Brave Search and any page an agent opens) | Agents' research | `mm-tools` |
| `data-providers` | FRED, FMP and NewsAPI | Market and economic data for background jobs | `mm-tools` |

## Dependency rules

Prose until dependency-cruiser enforces them.

- `dep.cockpit`: The cockpit's components (`ui-*`) depend only on `config` types and on each other; they reach the platform only over the control plane's HTTP API.
- `dep.ui-api`: Only `ui-api` calls the control plane; every other cockpit component goes through it.
- `dep.through-home`: Entry points (`cp-api`, `cp-copilot`, `cp-mc-gateway`, `mm-monitor`, `mm-mission-copilot`) reach mission state changes through their operation's home, never by writing the collection directly.
