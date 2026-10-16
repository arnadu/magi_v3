# Trust boundaries — who holds what, who writes what

The input for whole-repo audits (`/sprint-audit`'s boundary auditor) and the check behind
CLAUDE.md's INV-2/INV-3. `threat-model.md` has the full STRIDE analysis per boundary (TB-1..TB-22);
this page is the compact answer to one question for every privileged actor: **which of the inputs
it acts on can be written by someone less trusted?** A row where the "writable by" column names a
less-trusted actor and the "guard" column is empty is a finding.

Trust order, most to least: operator (Firebase-signed-in human, or `CONTROL_API_KEY`) · control
plane process · mission daemon (`magi-operator`) · control-plane copilot (`magi-copilot` OS user,
LLM-driven) · mission copilot (own OS user, LLM-driven, reads every teammate's output) · mission
agent (own OS user, LLM-driven) · background job (agent's OS user, agent-authored code) · tenant
(any signed-in user, as seen from another tenant's mission) · the internet (web pages, documents,
LLM providers' responses).

## Actors and the secrets they hold

| Actor | OS identity | Secrets in its environment | Can reach |
|---|---|---|---|
| Control plane (Express, Fly `magi-control-*`) | container user (`magi-operator`) | `CONTROL_API_KEY`, `MONITOR_SIGNING_KEY`, `FLY_API_TOKEN_MACHINES`, `MONGODB_URI` (cluster-wide), `FIREBASE_SERVICE_ACCOUNT_KEY`, `GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, provider keys | every tenant's Mongo data; every mission machine (TB-10, TB-11); GitHub (TB-16) |
| Control-plane copilot (in-process LLM loop; its Bash via `sudo -u magi-copilot`) | `magi-copilot` — **one identity for all users' copilots** (TB-15) | none in its Bash (clean-env sudo child); its Tier B tools run in-process with the control plane's Mongo/Fly access, `userId`-scoped | its user's missions via Tier B tools; `workdir/users/copilot-<uid>` (F-036); other users' subdirectories via Bash (open, TB-15) |
| Mission daemon (one Fly machine per mission) | `magi-operator` (uid 999) | `MONGODB_URI` (cluster-wide, **X-TENANT2**), `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `BRAVE_SEARCH_API_KEY`, `MONITOR_TOKEN`, data-provider keys | all of Mongo; its own volume; sudo to any `%magi-shared` user (TB-3/TB-4) |
| Mission agents (incl. the mission copilot) | own OS user per agent (`ensureAgentUsers`) | none (`sudo` child gets only `PATH`, `HOME`) | own workdir (rwx), `shared/` (rwx, TB-7), other agents' workdirs (**read** — ISO1, open), the daemon's `:4000`/`:4001` on loopback |
| Background job | the submitting agent's OS user | `MAGI_TOOL_TOKEN` (scoped, revocable) | the Tool API (TB-5) as that agent |
| Tenant (another signed-in user) | — | — | their own missions (`userFilter`); shared `scheduled_messages` via copilot actions (EA1, open) |
| Internet | — | — | agent context via FetchUrl/BrowseWeb/documents (TB-8); the daemon via SSRF (S2, open) |

## Privileged operations and who can write their inputs

"Guard" names the code that makes the less-trusted writer safe. Rows marked **open** are audit
findings scheduled in `docs/plans/audit-oct26-remediation-plan.md` (committed at M1).

| Privileged operation (actor) | Input | Writable by | Guard |
|---|---|---|---|
| Parse team config (control plane, daemon) | `mission`/`agents`/`teamFiles` fields | tenant (`POST /api/missions`), mission copilot (`SaveMissionConfig`), control-plane copilot (`save_session_config`) | zod `TeamConfigSchema`; no env expansion (F-032); `validateTeamFiles` (F-033); reserved ids |
| Write team files to disk at boot (daemon) | `teamFiles[].path` | same three | `validateTeamFilePath` + parent realpath + `O_NOFOLLOW` (F-033) |
| Run git on the workspace (daemon) | hooks, config, filters, attributes | agents (`shared/` is rwx) | git dir outside `shared/` + `safe-git.ts` hardened env/args (F-034) |
| Create a mission (control plane) | `missionId` | tenant, control-plane copilot | `validateNewMissionId` (F-035) |
| Serve copilot files (control plane) | `?path=` | signed-in user | per-user root + realpath boundary (F-036) |
| Monitor file read/download/write/edit (daemon) | `?path=`, symlinks in `shared/` | agents; before F-042 any 6PN peer on GET | `safe-path.ts` `resolveInside` + `O_NOFOLLOW` opens, `lstat` listings, zip cap, no `.git*` writes (F-037); per-mission token on every route, constant-time, mandatory on Fly (F-042) |
| Any monitor route (daemon, binds `::`) | the request itself | every machine in the Fly app over 6PN (`<app>.internal`), i.e. every other tenant's agents | `x-monitor-token` required on every route incl. GET and `/events` (F-042); the proxy injects it, the mission copilot sends it; an empty token on Fly is a startup error |
| `Research` context files / output path (daemon, in-process) | paths | agent | `resolveInside` against the agent’s permitted roots, `readInside`/`writeFileInside`, pseudo-fs denied (F-038) |
| Artifact / document writes (daemon) | `shared/artifacts/<id>`, zip entry names | agent (symlink plant), web content | unpredictable id, exclusive `mkdirInside`, `O_EXCL\|O_NOFOLLOW` files, `safeEntryName` (F-039) |
| Run a background job (daemon, `sudo -u`) | `jobs/pending/*.json` incl. `agentId`, `id` | any agent | **open** — JOB1/JOB2 → owner-uid attribution, private queue (M1 B4, ADR-0033) |
| Ingest schedules (daemon) | `shared/schedules/*.json` | any agent | **open** (not built) — ADR-0033 |
| Skill discovery into system prompts (daemon) | `SKILL.md` frontmatter in agent-writable tiers | agents | **open** — SK1/WM1 (M1 B5) |
| Fetch a URL (daemon, in-process) | URL and every redirect hop | agent, web | `isPrivateHost` first hop only — **open** S2/S1 (M1 B3); BrowseWeb egress proxy (F-002) |
| Execute copilot `ProposeAction` (control plane) | payload | control-plane copilot (LLM), confirmed by the operator on a label only | ownership on most actions; **open** — EA1/CK-GATE (M2 D2), `file_github_issue` gate (M1 B6) |
| Execute an LLM tool call (daemon) | tool arguments | agent LLM, web-influenced | TypeBox schema declared, **open** — not validated (LP2, M2 D1) |
| Render agent output in the cockpit (browser) | markdown, file content, SVG | agents, web | escapes `& < >`; **open** — `"` and attribute breakout (XSS1, M1 C1); sandboxed iframes (TB-20) |
| Deliver scheduled messages, wake machines (control plane) | `scheduled_messages` docs | mission copilot, control-plane copilot | mission-scoped; **open** — cross-user create/cancel (EA1, M2 D2) |
| Provision / resize / destroy machines (control plane) | mission doc fields, Fly API | operator routes; mission copilot (TB-22, bounded) | `machine-lifecycle.ts` single choke point; `volumeExists` guard; `fix_mission_volume` derives ids server-side |
| Relay anomalies into copilot inboxes (daemon, control plane) | message text | agent-influenced strings (paths, errors) | **open** — AN1: unwrapped `from: "system"` text (M2) |

## Changing who can supply an input (INV-3)

The ENV1 root cause: `${VAR}` expansion was safe while config came only from the operator's disk,
and became Critical when the same parser started receiving tenant input months later, because the
diff that opened the new input path never re-read the old consumer. Rule: when a value that used to
come from the operator (a file, an env var, a template) can now come from a tenant, an agent or the
web (an API, a tool, a mailbox message), add a row here, re-review **every** consumer of that
value — not just the diff — and update `threat-model.md` in the same commit.
