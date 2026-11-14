# Components

**Draft, 2026-11-14 — awaiting approval.** The architecture baseline: the components MAGI is
built from, each with its responsibility and the source paths it owns. The product baseline
([../product/](../product/README.md)) says what MAGI does; this says how it is built. Each
operation's home lies in exactly one component.

Paths are the join with the code: every source file belongs to exactly one component (patterns
are matched in order, first match wins; tests excluded). Dependency rules, hotspots, coupling
and trust boundaries are expressed in these components.

## Control plane (`packages/control-plane/src/`)

| Id | Component | Responsibility | Paths |
|---|---|---|---|
| `cp-api` | Mission API | The operator's routes: missions, drafts, config, limits, reads | `mission-routes-*`, `missions.ts`, `mission-drafts.ts`, `mission-scope.ts`, `mission-status.ts`, `mission-resource-routes.ts`, `catalog-routes.ts`, `platform-routes.ts`, `public-routes.ts`, `templates.ts`, `config-version.ts`, `async-handler.ts` |
| `cp-mission-ops` | Mission operations | The homes of mission operations: lifecycle, launch claims, limits, spend | `mission-lifecycle-actions.ts`, `mission-claims.ts`, `mission-limits.ts`, `mission-spend.ts`, `spend-policy.ts`, `mission-stats-summary.ts` |
| `cp-machines` | Machine lifecycle | Fly machines and volumes: provision, wake, resize, upgrade, segments | `machine-*`, `fly-*`, `resource-upgrade*` |
| `cp-scheduler` | Scheduler | Delivering due schedules | `scheduler.ts` |
| `cp-oversight` | Resource oversight | Sampling, alerts, the daily report, platform relays | `resource-monitor.ts`, `resource-alerts.ts`, `resource-queries.ts`, `resource-report*`, `atlas-usage.ts`, `usage-queries.ts`, `platform-relay.ts`, `mailbox-writer.ts` |
| `cp-copilot` | Control copilot | Its loop, tools, proposals and their execution, visibility | `copilot-*`, `pending-actions.ts`, `transcript-queries.ts`, `github*.ts` |
| `cp-mc-gateway` | Mission-copilot gateway | What a mission copilot may ask the control plane for | `mission-copilot-router.ts` |
| `cp-edge` | Edge and identity | Sign-in, sessions, users, security headers, the proxy to mission machines, monitor tokens | `auth*.ts`, `session-routes.ts`, `firebase.ts`, `users.ts`, `security-headers.ts`, `proxy.ts`, `monitor-token.ts` |
| `cp-host` | Process host | Start-up, database, process guards | `index.ts`, `mongo.ts`, `process-guards.ts`, `types.d.ts` |

## Mission machine (`packages/agent-runtime-worker/src/`)

| Id | Component | Responsibility | Paths |
|---|---|---|---|
| `mm-daemon` | Daemon | Boot, orchestration, dispatch | `daemon.ts`, `daemon-boot/`, `orchestrator*`, `exit-on-fatal.ts`, `node-polyfill.ts` |
| `mm-agent-loop` | Agent loop | A turn: prompt, LLM calls, tools, limits, reflection, logging | `agent-runner*`, `loop*.ts`, `prompt.ts`, `prompts.ts`, `reflection.ts`, `context-utils.ts`, `limits.ts`, `llm-*`, `models.ts`, `openrouter-pricing.ts`, `retry-backoff.ts`, `agent-stats.ts`, `usage.ts`, `mental-map.ts`, `skills.ts` |
| `mm-tools` | Agent tools | The tools agents call and their isolated execution | `tools/`, `tools.ts`, `tool-catalog.ts`, `tool-args.ts`, `tool-executor.ts`, `images/`, `document-*`, `pdf-*`, `ocr-cap.ts`, `mime-types.ts`, `artifacts.ts` |
| `mm-mission-copilot` | Mission copilot | Its tools and their checks | `mission-copilot*`, `resource-upgrade-tool.ts` |
| `mm-monitor` | Monitor server | The cockpit-facing routes on the mission machine (port 4000) | `monitor-*`, `monitor-routes/` |
| `mm-jobs` | Jobs and schedules | Background jobs, the Tool API (port 4001), schedule ingestion | `job-*`, `tool-api-server.ts`, `schedule-ingest.ts` |
| `mm-state` | Mission state | Mailbox, conversations, config, objectives, stats, anomalies, resources | `mailbox.ts`, `conversation-repository.ts`, `mission-config*`, `objectives/`, `anomaly*`, `resource-alert-state.ts`, `resource-sampler.ts`, `resource-thresholds.ts`, `mongo.ts` |
| `mm-isolation` | Isolation and safety | OS users, workspaces, git, safe paths and HTTP | `linux-user.ts`, `workspace-*`, `safe-*`, `ssrf.ts`, `remove-if-exists.ts` |
| `mm-cli` | Developer CLI | Local commands | `cli*.ts`, `user-input.ts`, `index.ts` |

## Shared and front end

| Id | Component | Responsibility | Paths |
|---|---|---|---|
| `config` | Configuration and stored types | Team-config schema, stored document types, collections, model defaults, the env catalogue | `packages/agent-config/src/` |
| `cockpit` | Cockpit | The operator's UI | `packages/cockpit/src/` |
| `skills` | Platform skills | Skills shipped to every mission | `packages/skills/` |

## Dependency rules (to be completed)

- The cockpit depends only on `config` types and on the control plane's HTTP API.
- Entry points (`cp-api`, `cp-copilot`, `cp-mc-gateway`, `mm-monitor`, `mm-mission-copilot`)
  reach mission state changes through their operation's home, never by writing the collection
  directly.
