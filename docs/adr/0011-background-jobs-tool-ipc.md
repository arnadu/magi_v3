# ADR-0011: Background Job Execution and Tool IPC

## Status

Accepted. Sprint 12.

## Context

Sprint 11 equity-research operations revealed that data collection (price feeds, news
fetches, macro series) consumed a disproportionate share of each agent's token budget.
The same URLs were fetched redundantly across sessions because there was no persistent
data store — every agent wakeup started from scratch.

The solution is a **data factory**: a set of background scripts that pre-fetch and
process structured data, writing results to files the agents read instead of browsing
the web on every wakeup. These scripts must:

1. Run as the agent's Linux user (`magi-wN`) — same filesystem isolation as the Bash tool
2. Call LLM-requiring tools (Research, FetchUrl, PostMessage) to synthesise briefs and
   notify agents on completion
3. Run on a schedule (e.g. daily at 05:30) without operator intervention
4. Not hold API keys directly — keys must remain in the daemon process

Requirement 2 creates a dependency on the daemon: the daemon holds `ANTHROPIC_API_KEY`
and is the only process that can make LLM calls. A background script running as `magi-w1`
cannot call Anthropic directly.

## Decision

### Tool IPC via HTTP with bearer tokens

The daemon runs a second HTTP server (`ToolApiServer`, port 4001, loopback-only) that
exposes LLM-requiring tools to scripts via `POST /tools/<name>`. Scripts authenticate
with a short-lived bearer token (`MAGI_TOOL_TOKEN`) injected by the daemon at job start.

The `magi-tool` CLI wraps this HTTP API for use in shell scripts and Python:
```bash
magi-tool research --question "..." --output brief.md
magi-tool post-message --to data-scientist --subject "Refresh done"
```

**Why HTTP, not Unix sockets:**
Containers. In the current single-process deployment, a Unix socket would also work.
But the target topology is pod-per-agent on Kubernetes, where a shared socket requires
a shared volume mount between pods — fighting against isolation. HTTP with
`MAGI_TOOL_URL` as an env var requires only an env var change to move from loopback
to a cluster-internal service. No code change in scripts or the SDK.

**Why bearer tokens, not ambient auth:**
The daemon needs to enforce `AclPolicy` per agent (permittedPaths, permittedTools).
A token maps to a specific agent's policy. Scripts from different agents running
concurrently each get different tokens — the ToolApiServer enforces the right policy
for each call. Tokens are minted just before spawn and revoked on process exit, so
they are short-lived and tied to actual job execution.

### Daemon-as-launcher (not OS cron)

The daemon spawns background job processes rather than delegating to the OS cron
(`crontab -u magi-w1`). This is necessary because the daemon is the token authority:
it holds the API keys and the in-memory `Map<token, AclPolicy>`. A process spawned
directly by OS cron would have no `MAGI_TOOL_TOKEN` and every `magi-tool` call would
fail with 401.

The tradeoff: the daemon (running as `remyh`) must impersonate `magi-w1` via `sudo`.
This is the same pattern already used for every Bash/WriteFile/EditFile tool call
(`sudo -u magi-w1 magi-node dist/tool-executor.js`). Background jobs are just
longer-running instances of the same pattern.

### The `magi-job` wrapper and sudoers

`sudo NOPASSWD` rules must name a fixed binary path. Agent-written scripts are arbitrary
paths — there is no safe way to write a rule like `NOPASSWD: /tmp/*`. Instead, a
one-line wrapper at a fixed path serves as the sudoers entry point:

```sh
# /usr/local/bin/magi-job
exec "$@"
```

The daemon spawns:
```
sudo -u magi-w1 /usr/local/bin/magi-job /path/to/script.sh [args...]
```

Sudoers rules in `/etc/sudoers.d/magi`:
```
remyh ALL = (magi-w1, …) NOPASSWD: /usr/local/bin/magi-job
Defaults!/usr/local/bin/magi-job env_keep += "MAGI_TOOL_URL MAGI_TOOL_TOKEN …"
```

The `env_keep` directive is required because sudo's `env_reset` default strips all env
vars from the child process. Without it, `MAGI_TOOL_TOKEN` would be absent in the script
environment and every `magi-tool` call would return 401. The `Defaults!<cmd>` scope
limits the env preservation to `magi-job` calls only.

This mirrors the existing `magi-node` wrapper (tool-executor), which uses the same
fixed-path + NOPASSWD approach. `magi-node` does not need `env_keep` because
tool-executor only needs `PATH` and `HOME` (no secrets in the tool-executor child).

### File-based job state (no new MongoDB collection)

Job lifecycle is tracked via files in `sharedDir/jobs/`:
```
jobs/pending/<id>.json   — job spec (written by submit-job.sh or heartbeat)
jobs/running/<id>.json   — atomically moved from pending on pickup (prevents double-run)
jobs/status/<id>.json    — final status: { exitCode, startedAt, completedAt }
logs/bg-<id>.log         — stdout+stderr of the job process
```

Agents check job status and logs via `Bash` (`cat`, `tail`) — no query API needed.
No new MongoDB collection. The Change Stream wakeup on completion uses the existing
mailbox — the daemon posts a message to the agent's inbox, which is identical to any
other inbox event.

## End-to-end sequence

```
1.  Daemon starts                                    [remyh]
      └─ ToolApiServer listening on 127.0.0.1:4001
      └─ node-cron heartbeat armed

2.  Operator posts task to agent mailbox             [remyh / user]

3.  Daemon runs agent loop — agent processes inbox   [remyh]
      └─ Agent calls Bash tool → submit-job.sh
         or schedule-job.sh to register a recurring job
      ┌─ Bash tool executes as the agent linux user: [magi-w1]
      │    submit-job.sh  → writes sharedDir/jobs/pending/<id>.json
      │    schedule-job.sh → writes sharedDir/schedules/<label>.json
      └─ Agent sends confirmation to user, goes idle

4.  Daemon heartbeat fires (node-cron, every minute) [remyh]
      └─ Reads schedules/*.json, upserts scheduled_messages
      └─ Delivers overdue scheduled_messages:
           • spec without jobSpec → PostMessage to agent mailbox
           • spec with jobSpec   → writes jobs/pending/<id>.json
      └─ Calls runPendingJobs()

5.  runPendingJobs() launches the job                [remyh → magi-w1]
      └─ Daemon mints MAGI_TOOL_TOKEN (UUID → AclPolicy in memory)
      └─ Moves spec: jobs/pending/ → jobs/running/
      └─ Spawns:
           sudo -u magi-w1 /usr/local/bin/magi-job /path/to/script.sh
         with env: PATH, HOME, MAGI_TOOL_URL, MAGI_TOOL_TOKEN, data keys
      └─ stdout+stderr piped to logs/bg-<id>.log

6.  Job script runs                                  [magi-w1]
      └─ File I/O, data fetching (native — no token needed)
      └─ Calls LLM-requiring tools via magi-tool CLI:
           magi-tool research --question "..." --output brief.md
           magi-tool post-message --to agent --subject "done"
         Each call: HTTP POST 127.0.0.1:4001/tools/<name>
                    Authorization: Bearer <MAGI_TOOL_TOKEN>

7.  ToolApiServer handles tool call                  [remyh]
      └─ Validates token → looks up AclPolicy
      └─ Runs tool (Research / FetchUrl / PostMessage / …)
      └─ Returns JSON result to magi-tool
      └─ magi-tool exits 0/1

8.  Job script exits                                 [magi-w1 → remyh]
      └─ Daemon: revokes MAGI_TOOL_TOKEN
      └─ Writes jobs/status/<id>.json  { exitCode, completedAt }
      └─ Posts completion message to agent mailbox (if notifySubject set)
      └─ runningJobs-- (slot freed for next job)

9.  Daemon Change Stream fires on new mailbox entry  [remyh]
      └─ Runs agent loop — agent reads completion notification
      └─ Agent reports result to user
```

## Consequences

**Positive:**
- Scripts call the same tools available in the agent loop with the same privilege
  boundaries — no new privilege surface
- Tokens are short-lived (job lifetime only) and scoped to the agent's AclPolicy
- File-based state is debuggable via plain Bash; no extra query tooling needed
- HTTP tool IPC is container-ready (env var change only for Kubernetes)

**Negative:**
- Daemon must `sudo` into the agent's Linux user — same as tool-executor, but now for
  long-running processes. A crashed daemon leaves orphaned `magi-w1` processes; they
  complete but their completion notification is lost. (Mitigation: on restart, daemon
  rescans `jobs/running/` and marks stale entries failed.)
- `setup-dev.sh` must be re-run whenever the `magi-job` wrapper or `env_keep` list
  changes. Forgetting produces silent 401 failures in job scripts.
- Max 3 concurrent jobs is a hard-coded constant; no per-agent limits.

## Alternatives considered

**OS cron per agent user:** `crontab -u magi-w1` would run scripts natively as `magi-w1`
without any sudo. Rejected because there is no clean way to inject `MAGI_TOOL_TOKEN` —
the token must be minted by the daemon at job-start time, and OS cron has no hook for
that. A pre-issued long-lived token stored in the agent's home would be valid even when
no job is running, weakening the security model.

**Unix socket IPC:** Would avoid the HTTP overhead on loopback. Rejected for the
container migration reason above — shared Unix socket requires a shared volume between
pods.

**Separate token-request endpoint (OAuth2-style):** Scripts running as `magi-w1` could
authenticate to the daemon by Linux uid (SO_PEERCRED on a Unix socket) and request a
short-lived token. Clean, but adds a second auth protocol and requires the daemon to
expose a pre-auth endpoint. Deferred — can be layered on later if Unix socket auth
becomes necessary for Kubernetes.
