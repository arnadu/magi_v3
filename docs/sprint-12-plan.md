# Sprint 12 Plan: Data Factory + Secondary Model + run-background

**Status:** Phase 1 ✅ Phase 2 ✅ Phase 3 ← next | Phase 4 | Phase 5

---

## Context

During Sprint 11 equity research operations, agents spent excessive tokens on redundant web fetches:
7–10 agents independently hitting the same URLs per cycle, 30–40 SearchWeb calls for minor query
variations, and no time-series persistence between sessions. This sprint builds a **data factory** —
a pre-fetched, structured data store that agents read instead of browsing the web on every wakeup.

Companion changes:
- **Tool API server** (`src/tool-api-server.ts`) — HTTP server (port 4001) exposing LLM-requiring
  tools to agent-written scripts via bearer token auth; container-ready (`MAGI_TOOL_URL` env var)
- **`run-background` / `schedule-job`** — daemon infrastructure: scripts run as the agent's linux
  user; LLM tools called via the Tool API; the only new privilege surface is the token, which maps
  to the agent's existing AclPolicy and cannot escalate beyond it
- **Python SDK** (`magi_tool.py`) — stdlib-only SDK so agent scripts call FetchUrl, Research,
  PostMessage etc. without reinventing the wheel
- **Secondary model (`VISION_MODEL`)** — Haiku for image captioning, browser automation, URL
  fetching; Sonnet kept for agent reasoning, reflection, Research synthesis

---

## Part 1 — Tool IPC Server + `run-background` + `schedule-job`

### Design goals

Agents should be able to write their own scripts, schedule them, and have those scripts call the
same tools available in the agent loop — with the same privilege boundaries. Specifically:

- Scripts run as the agent's Linux user (`magi-wN`) — same isolation as the Bash tool today
- File operations, shell commands: the script does these natively (it IS the linux user already)
- LLM-requiring tools (FetchUrl, InspectImage, BrowseWeb, Research, SearchWeb, PostMessage):
  these execute in the daemon process (which holds the API keys); the script calls them via IPC

This extends the existing security model rather than bypassing it. No new privilege surfaces are
introduced.

### Tool IPC — HTTP with bearer tokens (container-ready)

**Why HTTP, not Unix sockets:**
Unix sockets require a shared filesystem between the daemon and the script. In the current
single-container deployment this works, but in the Kubernetes future each agent may run in its
own pod — a shared socket file requires a shared volume mount, coupling pods together in ways
that fight against pod-per-agent isolation. HTTP is the universal IPC mechanism for containerized
systems and requires no shared filesystem.

Migration path:
- **Today:** `MAGI_TOOL_URL=http://localhost:4001` — loopback, trivial
- **Kubernetes:** `MAGI_TOOL_URL=http://tool-api.mission-ns.svc.cluster.local:4001` — just an
  env var change; zero code changes in agent scripts or the Python SDK

**Tool API server** — separate HTTP server on `TOOL_PORT` (default 4001), distinct from the
operator monitor server (port 4000):
- Different auth models: monitor is operator-facing (no auth today); tool API requires bearer token
- Different network policy in production: agents can reach port 4001; operators have no reason to
- Same `http.createServer()` pattern as `monitor-server.ts`; reuses the same tool factory functions

**Authentication: session token**
- `MAGI_TOOL_TOKEN=<uuid>` injected by daemon into script env when spawning via `sudo -u linuxUser`
- Daemon holds `Map<token, AclPolicy>` in memory
- Token sent as `Authorization: Bearer <token>` on every tool call
- Token revoked when the script process exits (on-complete, on-fail, on-timeout)
- Token cannot escalate beyond the AclPolicy it was issued with — even if a script leaks the token
  to another process, that process can only call tools within the same agent's `permittedPaths`

**Protocol:** `POST /tools/<name>` with JSON body, JSON response.
- Success: `200 { result: { content: [...] } }`
- Tool error: `200 { error: "..." }` (tool ran but returned isError)
- Auth failure: `401`
- Unknown tool: `404`
- Timeout (120s default, configurable per tool): `504`

**Tools exposed via the API:**
| Tool | Why via API (not native) |
|------|--------------------------|
| FetchUrl | needs ANTHROPIC_API_KEY for image captioning |
| InspectImage | needs ANTHROPIC_API_KEY for vision LLM |
| BrowseWeb | needs ANTHROPIC_API_KEY for Stagehand |
| Research | needs ANTHROPIC_API_KEY for sub-loop |
| SearchWeb | needs BRAVE_SEARCH_API_KEY |
| PostMessage | needs MONGODB_URI + team roster validation |

Bash, WriteFile, EditFile are NOT in the API — the script runs as the agent's linux user already
and calls these natively. The existing `tool-executor.ts` path (stdin/stdout) is unchanged for
the agent loop; the HTTP API is the parallel path for agent-written scripts.

### Job scheduling and execution — file-based (no new MongoDB collections)

Job scheduling reuses the **existing `schedule-task` infrastructure** unchanged: the daemon's
`node-cron` heartbeat fires every minute, reads spec files from `sharedDir/schedules/`, upserts
into `scheduled_messages`, and delivers overdue entries.

The only extension is that a spec file can carry a `jobSpec` field instead of `to`/`subject`/`body`.
When the heartbeat encounters a `jobSpec` entry, instead of posting to the mailbox it runs the
job directly. Everything else — timing, re-arming, crash recovery, idempotent upsert — is
unchanged.

**Spec file format (extended):**

```json
{
  "label": "daily-refresh",
  "cron": "30 5 * * *",
  "jobSpec": {
    "scriptPath": "/missions/equity-research/shared/skills/_team/data-factory/scripts/refresh.py",
    "agentId": "data-scientist",
    "args": ["/missions/equity-research/shared"],
    "notifySubject": "Daily data factory refresh complete"
  }
}
```

One-shot jobs use the same format without the `cron` field — the entry is not re-armed after
delivery.

**Job state — spool directories under `sharedDir/jobs/`:**

```
sharedDir/jobs/
  pending/    ← submit-job.sh drops one-shot spec files here
  logs/       ← bg-<label>-<ts>.log  (stdout+stderr of spawned script)
  status/     ← <label>-<ts>.json    { status, startedAt, completedAt, exitCode, pid }
```

Agents read job status and logs via plain Bash — no MongoDB query needed:
```bash
cat $SHARED_DIR/jobs/status/daily-refresh-*.json | tail -1
tail -50 $SHARED_DIR/jobs/logs/daily-refresh-*.log
```

**Heartbeat extension in `daemon.ts` (new function `runPendingJobs`, ~40 lines):**
1. Scan `sharedDir/jobs/pending/` for spec files
2. Count currently running jobs (status files with `status: "running"`) — cap at 3
3. For each pending spec (up to the cap):
   - Validate `scriptPath` within agent's `permittedPaths`
   - Issue `MAGI_TOOL_TOKEN` from `ToolApiServer`
   - Move spec file from `pending/` to consumed (or delete it)
   - Write `status/` file with `status: "running"`
   - Spawn: `sudo -u <linuxUser> <scriptPath> <args...>`
     with env `{ PATH, HOME, MAGI_TOOL_URL, MAGI_TOOL_TOKEN, ...dataKeysEnv() }`
     stdout+stderr piped to `logs/<label>-<ts>.log`
   - On exit: revoke token, update status file, optionally PostMessage agent

**Why no MongoDB for job state:**
- Spec files already survive daemon restarts (same as schedule specs)
- Status files are directly readable by agents via Bash — no query layer needed
- The `schedule-task` skill already proves the file-based pattern works for scheduling
- MongoDB is for durable inter-agent communication and conversation history, not for
  ephemeral job bookkeeping

### New files

**`src/tool-api-server.ts`**:
```typescript
export class ToolApiServer {
  // token → { acl: AclPolicy, identity: AgentIdentity }
  issueToken(acl: AclPolicy, identity: AgentIdentity): string { ... }
  revokeToken(token: string): void { ... }
  listen(port: number): void { ... }
  stop(): void { ... }
}
```

Tool dispatch reuses existing factory functions verbatim:
- `createFetchUrlTool(visionModel, sharedDir)`
- `createInspectImageTool(workdir, visionModel)`
- `tryCreateBrowseWebTool(visionModel, sharedDir)`
- `createResearchTool(model, sharedDir, acl)`
- `createSearchWebTool(apiKey)`
- PostMessage (inline, uses mailboxRepo + team roster validation)

Started in `daemon.ts` after workspace provision. Port from `TOOL_PORT` env var (default 4001).
Validated at startup like `MONITOR_PORT` — daemon exits on invalid value.

**`src/cli-tool.ts`** — CLI client, compiled to `dist/cli-tool.js`:
```
Usage: magi-tool <tool-name> [--params '<json>'] [--output <path>]

Env vars: MAGI_TOOL_URL (default: http://localhost:4001), MAGI_TOOL_TOKEN
Output:   JSON to stdout (or written to --output file); exit 0/1
```

Installed at `/usr/local/bin/magi-tool` by `setup-dev.sh` (same wrapper pattern as `magi-node`).
Accessible to all agent linux users.

**Python SDK** — `packages/skills/run-background/scripts/magi_tool.py`:
```python
import os, json, urllib.request   # stdlib only — no pip install needed

_url = os.environ.get("MAGI_TOOL_URL", "http://localhost:4001")
_token = os.environ["MAGI_TOOL_TOKEN"]

def call_tool(name: str, **params) -> dict:
    body = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{_url}/tools/{name}",
        data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {_token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())

# Convenience wrappers
def fetch_url(url: str, max_images: int = 3) -> dict:
    return call_tool("fetch-url", url=url, max_images=max_images)

def research(question: str, max_age_hours: int = 12) -> dict:
    return call_tool("research", question=question, max_age_hours=max_age_hours)

def post_message(to: str, subject: str, body: str) -> dict:
    return call_tool("post-message", to=to, subject=subject, body=body)
```

Uses `urllib.request` (stdlib) — no pip install required. Agents import it with:
```python
import sys, os
sys.path.insert(0, os.path.join(os.environ["SKILL_DIR"], "..", "run-background", "scripts"))
import magi_tool
```

Or copy it to `$WORKDIR/scripts/` once at setup time.

### `run-background` platform skill (`packages/skills/run-background/`)

```
run-background/
  SKILL.md
  scripts/
    submit-job.sh    # one-shot: writes spec to sharedDir/jobs/pending/
    schedule-job.sh  # recurring: writes spec to sharedDir/schedules/ (with jobSpec field)
    job-status.sh    # read status file + tail log
    magi_tool.py     # Python SDK (stdlib only)
```

**`submit-job.sh`** (one-shot, e.g. "run refresh now"):
```bash
submit-job.sh \
  --script "$SKILL_DIR/scripts/refresh.py" \
  --args "$SHARED_DIR" \
  --agent data-scientist \
  --notify-subject "Refresh complete"
```
Writes `$SHARED_DIR/jobs/pending/<uuid>.json`. Picked up at next heartbeat (≤1 min).

**`schedule-job.sh`** (recurring):
```bash
schedule-job.sh \
  --cron "30 5 * * *" \
  --label "daily-refresh" \
  --script "$SKILL_DIR/scripts/refresh.py" \
  --args "$SHARED_DIR" \
  --agent data-scientist \
  --notify-subject "Daily data factory refresh complete"
```
Writes `$SHARED_DIR/schedules/daily-refresh.json` with `jobSpec` field. The heartbeat
imports it, fires at 05:30 each day, re-arms automatically.

---

## Part 2 — News Synthesis via Extended `Research` Tool

### Two-step pipeline (unchanged)

1. **Cheap, automated (Python, no LLM):** news adapters query sources → `process_news.py`
   de-duplicates, ranks, produces `digest.json` (up to 30 items: title, URL, summary, `is_new`).
   Zero tokens.

2. **LLM step (via Tool API):** `magi-tool research` with the digest and yesterday's brief
   injected as context files. Research decides which articles to fetch full-text, calls FetchUrl,
   produces an updated brief. No SearchWeb — all URL discovery is already done by the adapters.

### Extension to `Research` tool (`src/tools/research.ts`)

Add two optional params to the existing TypeBox schema:

```typescript
contextFiles?: string[]   // paths to read and inject into sub-loop opening message
previousResultPath?: string  // path to write the answer text (in addition to research cache)
```

**Behaviour when `contextFiles` provided:**
- Each file is read and its content prepended to the opening user message, labelled by filename
- System prompt gets an additional instruction: *"Context files have been provided. Fetch URLs
  found in those files rather than calling SearchWeb. SearchWeb is forbidden for this request."*
- `maxAgeHours` defaults to 0 (always fresh — digest changes daily)

**Behaviour when `previousResultPath` provided:**
- After the sub-loop completes, the answer text is written to that path
- Research cache (`sharedDir/research/index.json`) is still updated as normal — agents can later
  call `magi-tool research --question "..."` and get a cache hit if the same digest was used

All paths in `contextFiles` and `previousResultPath` are validated within `acl.permittedPaths`.
No new file; change is entirely within `src/tools/research.ts` (~30 lines).

### `refresh.sh` integration

```bash
# Step 1 — Python (no tokens):
python3 "$SKILL_DIR/scripts/process_news.py" \
  --raw    "$FACTORY/news/nvda/raw.json" \
  --existing "$FACTORY/news/nvda/digest.json" \
  --output  "$FACTORY/news/nvda/digest.json"

# Step 2 — LLM via Tool API:
CONTEXT_FILES="[\"$FACTORY/news/nvda/digest.json\",\"$FACTORY/news/nvda/brief.md\"]"
magi-tool research --params "{
  \"question\": \"Update the NVDA news brief based on today's digest. Fetch new articles,
    keep the previous brief's structure, note what changed since yesterday. Include Sources.\",
  \"contextFiles\": $CONTEXT_FILES,
  \"previousResultPath\": \"$FACTORY/news/nvda/brief.md\",
  \"maxAgeHours\": 0
}"
```

The `brief.md` passed as a context file lets the LLM see what was written yesterday — it can
note continuity ("NVDA continued its rally...") and flag genuinely new developments. On first
run, `brief.md` does not exist yet; Research silently skips missing context files.

### `magi-tool` CLI `--output` flag

`magi-tool research` already prints JSON. Add `--output <path>` to the CLI (not to Research
itself): the CLI writes the `answer` field to the file after a successful call. This is
equivalent to `previousResultPath` but callable from shell scripts without JSON construction:

```bash
magi-tool research \
  --question "..." \
  --context-file "$FACTORY/news/nvda/digest.json" \
  --context-file "$FACTORY/news/nvda/brief.md" \
  --output "$FACTORY/news/nvda/brief.md" \
  --max-age-hours 0
```

The CLI translates `--context-file` (repeatable) → `contextFiles: [...]` in the JSON body.

---

## Part 3 — Secondary (Vision) Model

### What changes

Four TypeScript files — no tool logic changes needed (tools already accept `model` parameter).

**Files to modify:**

| File | Change |
|------|--------|
| `packages/agent-runtime-worker/src/models.ts` | Add `CLAUDE_HAIKU` constant (haiku-4-5-20251001, $0.80/$4 per MTok) |
| `packages/agent-runtime-worker/src/orchestrator.ts` | Add `visionModel?: Model<string>` to `OrchestratorConfig` |
| `packages/agent-runtime-worker/src/agent-runner.ts` | Add `visionModel?: Model<string>` to `AgentRunContext`; use `ctx.visionModel ?? ctx.model` for FetchUrl, InspectImage, BrowseWeb |
| `packages/agent-runtime-worker/src/daemon.ts` | Parse `VISION_MODEL` env var; default to `CLAUDE_HAIKU`; pass as `visionModel` |
| `packages/agent-runtime-worker/src/cli.ts` | Same `VISION_MODEL` parsing + pass-through |

**Env var:** `VISION_MODEL` (optional; default: `claude-haiku-4-5-20251001`).
Set to `claude-sonnet-4-6` to use a single model everywhere.

**Which tools use visionModel vs primary model:**

| Tool | Model | Reason |
|------|-------|--------|
| FetchUrl | visionModel | `autoDescribeImage()` — captioning only |
| InspectImage | visionModel | `completeSimple` with image input only |
| BrowseWeb (Stagehand) | visionModel | page understanding, not agent reasoning |
| Research sub-loop | model (primary) | full reasoning chain |
| Inner loop | model (primary) | agent reasoning |
| Reflection | model (primary) | synthesis reasoning |

Note: when `magi-tool research` is called from `refresh.sh` with `contextFiles`, the ToolApiServer
uses the primary model (Sonnet) for the Research sub-loop — same as when agents call Research
directly. The visionModel (Haiku) is used for FetchUrl image captioning within that sub-loop.
If cost becomes a concern, the ToolApiServer can use visionModel for Research calls originating
from background jobs (detectable by the token's `linuxUser` origin).

---

## Part 4 — Data Factory Python Skill (`data-factory/`)

### Two-skill architecture

| Skill | Who uses it | Contents |
|-------|-------------|----------|
| `data-factory/` | Lin (Data Scientist) only | setup, refresh, add sources, schedule |
| `data-factory-client/` | Alex, Marco, Sam | catalog reads, series access, digest reads |

Lin is the operator of the data factory. Other agents are consumers.
This prevents the other agents' system prompts from being cluttered with operator instructions.

### Directory layout

All files under `config/teams/equity-research/skills/data-factory/`.

```
data-factory/
  SKILL.md
  sources.json
  schedule.json
  requirements.txt
  scripts/
    refresh.sh
    catalog.py
    process_news.py
    adapters/
      adapter_fmp.py
      adapter_fred.py
      adapter_yfinance.py
      adapter_newsapi.py
      adapter_gdelt.py
      adapter_imf.py
      adapter_worldbank.py

data-factory-client/
  SKILL.md
  scripts/
    read-catalog.sh    # catalog.py list $FACTORY wrapper
    read-series.sh     # tail -N on a named series CSV
    read-digest.sh     # print is_new items from a digest.json
```

**`read-catalog.sh`**: `python3 $DF_SCRIPTS/catalog.py list $FACTORY [$--json]`
**`read-series.sh`**: `read-series.sh <series-id> [--rows N]` → `tail -N $FACTORY/series/<id>.csv`
**`read-digest.sh`**: `read-digest.sh <news-id>` → prints `is_new:true` items from digest.json as
  formatted table (title, source, published_at, url)

No `process_document.py` — agents call `FetchUrl` on-demand from the filing index. PDF/HTML
processing is already solved by `FetchUrl` + mupdf; no Python reimplementation needed.

### `data-factory/SKILL.md` content (for Lin)

```yaml
---
name: data-factory
description: |
  Pre-fetched data store for NVDA equity research. You are the operator.
  Run refresh.sh before writing briefs. Manage sources.json and schedule.json.
  Covers: OHLCV price/volume, macro rates, news digests + briefs, SEC filing index.
scope: team
---

## Quick Start (first run)
  mkdir -p $FACTORY
  pip3 install -r $SKILL_DIR/requirements.txt
  cp $SKILL_DIR/sources.json $FACTORY/sources.json      # edit to add/remove sources
  cp $SKILL_DIR/schedule.json $FACTORY/schedule.json
  bash $SKILL_DIR/scripts/refresh.sh $SHARED_DIR        # first full refresh (~5 min)
  python3 $SKILL_DIR/scripts/catalog.py list $FACTORY   # verify all sources ok
  bash $SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh \
    --cron "30 5 * * *" --script $SKILL_DIR/scripts/refresh.sh \
    --args $SHARED_DIR --agent data-scientist \
    --notify-subject "Daily refresh complete"
  PostMessage lead-analyst with catalog summary

## Operator tasks
Add source:   edit $FACTORY/sources.json, add entry, run refresh.sh manually
Remove source: edit $FACTORY/sources.json, remove entry (data files remain until deleted)
Check errors: python3 $SKILL_DIR/scripts/catalog.py list $FACTORY  (status=error rows)
Manual refresh: bash $SKILL_DIR/scripts/refresh.sh $SHARED_DIR
Check budget: cat $FACTORY/.fmp_usage_$(date +%Y-%m-%d)   (must stay < 200)

## API keys required (set in .env, NOT in agent scripts)
  FMP_API_KEY          — price/volume, SEC filings
  FRED_API_KEY         — macro rates (free, register at fred.stlouisfed.org)
  NEWSAPIORG_API_KEY   — news headlines (free tier: 100 req/day)
```

### `data-factory-client/SKILL.md` content (for Alex, Marco, Sam)

```yaml
---
name: data-factory-client
description: |
  Read pre-fetched NVDA equity data. Always check the catalog before using Research or SearchWeb.
  Covers: OHLCV price/volume, macro rates, news briefs, SEC filing index.
scope: team
---

## Step 1: check what's available
  python3 $SKILL_DIR/../data-factory/scripts/catalog.py list $FACTORY
  # Shows: id, type, status (ok/error/stale), fetched_at, path

## Time-series data (CSV: date, value columns; newest row last)
  tail -3 $FACTORY/series/fmp/NVDA_daily_price.csv     # date,open,high,low,close,volume
  tail -3 $FACTORY/series/fred/DFF.csv                 # date,value  (Fed funds rate)
  tail -3 $FACTORY/series/fred/T10Y2Y.csv              # date,value  (yield curve spread)
  tail -3 $FACTORY/series/fred/CPIAUCSL.csv            # date,value  (CPI)
  ls $FACTORY/series/                                  # discover all available series

## News brief (updated daily by refresh.sh)
  cat $FACTORY/news/nvda_competitive_landscape/brief.md
  cat $FACTORY/news/nvda_competitive_landscape/digest.json   # raw ranked list if you need URLs

## SEC filings index (updated weekly)
  cat $FACTORY/documents/NVDA/filings/index.json
  # Format: [{ "type": "10-K", "date": "2025-01-15", "url": "https://..." }, ...]
  # To read a specific filing: FetchUrl on the url field (no local copies stored)

## Fallback rule
  If status=error or status=stale for a series you need:
    use magi-tool research --question "..." to fetch it live
    PostMessage data-scientist to flag the broken source
```

### `requirements.txt`

```
requests>=2.31
yfinance>=0.2
html2text>=2020.1
pytest>=7.0
```

No `pymupdf` — PDF processing delegated to `FetchUrl` (mupdf is already in the Node stack).

### `sources.json` structure

```json
{
  "series": [
    {
      "id": "fmp/NVDA_daily_price",
      "adapter": "fmp",
      "params": { "ticker": "NVDA", "type": "daily" },
      "schedule": "daily",
      "output": "series/fmp/NVDA_daily_price.csv"
    },
    {
      "id": "fred/DFF",
      "adapter": "fred",
      "params": { "series_id": "DFF" },
      "schedule": "daily",
      "output": "series/fred/DFF.csv"
    }
  ],
  "news": [
    {
      "id": "nvda_competitive_landscape",
      "adapter": "newsapi",
      "params": { "q": "NVIDIA GPU datacenter AI chip", "language": "en" },
      "schedule": "daily",
      "output_dir": "news/nvda_competitive_landscape"
    }
  ],
  "documents": [
    {
      "id": "NVDA_filings",
      "adapter": "fmp",
      "params": { "ticker": "NVDA", "type": "sec_filings" },
      "schedule": "weekly",
      "output": "documents/NVDA/filings/index.json"
    }
  ]
}
```

### `schedule.json`

```json
{
  "refresh_cron": "30 5 * * *",
  "fmp_daily_budget": 200,
  "news_max_articles_fetch": 5
}
```

Note: `news_synthesis_model` removed — the Research tool model is set at the daemon level via
`MODEL` / `VISION_MODEL` env vars, not by agent scripts.

### `refresh.sh` design

Preamble: Python dependency check (`python3 -c "import requests"` → pip install if absent).

Execution flow:
1. Run non-FMP adapters in parallel Python threads (via `catalog.py refresh`)
2. Run FMP adapters sequentially with budget guard (counter file `$FACTORY/.fmp_usage_YYYY-MM-DD`)
3. For each news source: run `process_news.py` → `digest.json` (pure Python, no tokens)
4. For each news digest: call `magi-tool research` with `--context-file digest.json
   --context-file brief.md --output brief.md --max-age-hours 0` (Tool API → daemon →
   Research sub-loop → FetchUrl new articles → writes updated `brief.md`)
5. Update `catalog.json` with status/timestamps

Append-only log: `$FACTORY/refresh.log`, each run starts with `=== refresh.sh YYYY-MM-DDThh:mm ===`.

**FMP budget guard** (in `catalog.py`):
- Free tier: 250 calls/day. Guard at 200 (buffer for ad-hoc agent calls)
- Counter file: `$FACTORY/.fmp_usage_YYYY-MM-DD`, contains one integer
- If counter ≥ 200: log warning, mark catalog entry `status=skipped`, continue non-FMP sources
- Counter incremented before each FMP adapter call

### `catalog.py` interface

```bash
python3 catalog.py list $FACTORY            # prints all entries as table
python3 catalog.py list $FACTORY --json     # JSON output
python3 catalog.py show $FACTORY <id>       # one entry + path + last fetch time
python3 catalog.py refresh $FACTORY sources.json [--fmp-budget-file F] [--log L]
```

Catalog file: `$FACTORY/catalog.json`
```json
[
  {
    "id": "fmp/NVDA_daily_price",
    "output": "series/fmp/NVDA_daily_price.csv",
    "status": "ok|error|skipped|stale",
    "fetched_at": "2026-04-04T05:30:00Z",
    "rows": 252,
    "error": null
  }
]
```

Staleness: `daily` → `fetched_at` date portion < today (ISO date comparison). `weekly` → < 7 days.

### `process_news.py` interface

```bash
python3 process_news.py \
  --raw $FACTORY/news/nvda_competitive_landscape/raw.json \
  --existing $FACTORY/news/nvda_competitive_landscape/digest.json \
  --output $FACTORY/news/nvda_competitive_landscape/digest.json
```

Output digest:
```json
{
  "generated_at": "2026-04-04T05:31:00Z",
  "items": [
    {
      "title": "...", "url": "...", "source": "...",
      "published_at": "...", "summary": "...", "is_new": true
    }
  ]
}
```

Ranking: newest first, NVDA-relevant keywords up-weighted. Max 30 items. De-duplication: URL
exact match + title fuzzy match (Levenshtein ≤ 0.15).

### Adapter interface (all 7 adapters)

Uniform CLI:
```bash
python3 adapter_fmp.py --discover              # { "series": [...] }
python3 adapter_fmp.py --fetch <outputPath> --series-id <id> --params '<json>'
```

Exit 0 on success, non-zero on error.

**Adapters:**
- `adapter_fmp.py` — price/volume OHLCV, SEC filing index (FMP_API_KEY)
- `adapter_fred.py` — FRED macro: DFF, T10Y2Y, UNRATE, CPIAUCSL (FRED_API_KEY)
- `adapter_yfinance.py` — yfinance fallback for price/volume (no key)
- `adapter_newsapi.py` — NewsAPI headlines (NEWSAPIORG_API_KEY)
- `adapter_gdelt.py` — GDELT news events (no key)
- `adapter_imf.py` — IMF macro data (no key)
- `adapter_worldbank.py` — World Bank macro data (no key)

### Data layout under `$FACTORY/`

```
$FACTORY/
  catalog.json
  refresh.log
  .fmp_usage_YYYY-MM-DD
  series/
    fmp/NVDA_daily_price.csv
    fred/DFF.csv
    fred/T10Y2Y.csv
  news/
    nvda_competitive_landscape/
      raw.json        (adapter output)
      digest.json     (process_news.py output)
      brief.md        (magi-tool research --context-file digest.json output; updated daily)
  documents/
    NVDA/
      filings/
        index.json    (list of SEC filings: url, type, date)
        # NO local copies — agents call FetchUrl on-demand
```

---

## Part 5 — equity-research.yaml Updates (Additive)

### Lin (Data Scientist)

Add Data Factory Operator section: setup instructions (mkdir, pip install, copy sources/schedule,
first refresh, catalog review, register 05:30 schedule-job, PostMessage Alex).

### Alex (Lead Analyst)

Add: check catalog before each cycle; include artifact paths in tasks; note error entries.
Add `<section id="data-factory-status">` to `initialMentalMap`.

### Marco (Economist)

Add: FRED series paths, news brief path, fallback rule (Research only for FOMC text, Fed speeches,
PMI narrative, hyperscaler transcripts).

### Sam (Junior Analyst)

Add: NVDA price/volume path, news brief path, filing index path + FetchUrl on-demand pattern,
fallback rule (Research only for earnings call transcripts, product press releases).

---

## Part 6 — OPERATOR_GUIDE.md + playbook.json Updates

**OPERATOR_GUIDE.md** — add sections:
- Data Factory: what it is, catalog reads, manual refresh, add source, API key requirements
- Background Jobs: submit-job.sh, schedule-job.sh, job-status.sh, log locations

**playbook.json** — add Step 2e:
- PostMessage Lin to set up data factory, pip install, first refresh, register 05:30 schedule-job,
  report catalog summary to Alex

---

## Part 7 — CLAUDE.md Sprint 12 Documentation

- Sprint 12 row in roadmap table
- `VISION_MODEL` env var (new); `TOOL_PORT` env var (new, default 4001)
- `background_jobs` MongoDB collection
- `tool-api-server.ts`, `cli-tool.ts` — tool HTTP API + `magi-tool` CLI
- `tools/research.ts` — extended with `contextFiles` + `previousResultPath` params
- `run-background` + `schedule-job` platform skills (including `magi_tool.py` Python SDK)
- `data-factory/` and `data-factory-client/` team skills
- `requirements.txt` and Python bootstrap

---

## Implementation Phases

### Phase 1 — Vision model ✅ DONE

Files: `models.ts`, `orchestrator.ts`, `agent-runner.ts`, `daemon.ts`, `cli.ts`

`CLAUDE_HAIKU` constant added; `visionModel?` wired through `OrchestratorConfig` → `AgentRunContext`;
`FetchUrl`, `InspectImage`, `BrowseWeb` use `ctx.visionModel ?? ctx.model`. `VISION_MODEL` env var
parsed in `daemon.ts` and `cli.ts`. `DATA_KEY_NAMES` + `dataKeysEnv()` added to `daemon.ts`;
`.env.data-keys` loaded at startup. `setup-dev.sh` creates `/opt/magi/venv` + `magi-python3` wrapper.

---

### Phase 2 — Data factory Python core ✅ DONE

Files (all under `config/teams/equity-research/skills/`):
- `data-factory/requirements.txt`, `sources.json`, `schedule.json`
- `data-factory/SKILL.md`, `data-factory-client/SKILL.md`
- `data-factory/scripts/catalog.py`
- `data-factory/scripts/process_news.py`
- Adapters in priority order (no API key first):
  - `adapter_yfinance.py` ← NVDA price, testable immediately
  - `adapter_gdelt.py` ← news, testable immediately
  - `adapter_fred.py`, `adapter_fmp.py`, `adapter_newsapi.py`, `adapter_imf.py`,
    `adapter_worldbank.py` ← need API keys, verify manually
- `data-factory-client/scripts/read-catalog.sh`, `read-series.sh`, `read-digest.sh`

**Unit tests** (`tests/data_factory/`, stdlib `unittest` — no API keys, no LLM for yfinance/gdelt):

`test_catalog.py`:
- Empty factory dir → `catalog.py list` → empty table, exit 0
- `catalog.py refresh` with yfinance adapter (NVDA) → `status=ok`, CSV exists, `rows > 0`
- Simulate adapter failure (bad ticker `INVALID123`) → `status=error`, error field set

`test_process_news.py`:
- Two items with identical URL → 1 item in output
- Two items with near-identical title (Levenshtein ≤ 0.15) → 1 item
- Item URL in existing digest → `is_new=false`; new URL → `is_new=true`
- Newer item ranked before older; input of 50 items → output truncated to 30

`test_adapter_yfinance.py`:
- `--discover` → valid JSON with at least one series entry
- `--fetch /tmp/nvda.csv --series-id yfinance/NVDA --params '{"ticker":"NVDA"}'`
  → exit 0, CSV has columns `date,open,high,low,close,volume`, ≥1 row

All 5 test files passing. Additional notes vs original plan:
- `refresh.sh` replaced by `refresh.py` — pure Python orchestrator; no bash heredocs
- `catalog.py` `cmd_refresh` takes `fmp_budget` parameter (was inline)
- `process_news.py` exports `process()` + `mark_new()` as standalone functions (enables testing)
- Unit tests use `python3 -m unittest discover tests/data_factory -v` (not pytest — pytest not in PATH without venv)

---

### Phase 3 — Tool API + Background Jobs (TypeScript, requires daemon) ← NEXT

**New files:**
- `src/tool-api-server.ts` — HTTP server port 4001, bearer token auth, tool dispatch
- `src/cli-tool.ts` — `magi-tool` CLI with `--context-file`, `--output` flags

**Modified files:**
- `src/daemon.ts` — start ToolApiServer; extend heartbeat with `runPendingJobs()`; extend
  `importScheduleFiles()` to handle `jobSpec` field; add `TOOL_PORT` env var validation
- `src/tools/research.ts` — add `contextFiles?` + `previousResultPath?` params (~30 lines)
- `setup-dev.sh` — install `magi-tool` wrapper at `/usr/local/bin/magi-tool`

**New skill:**
- `packages/skills/run-background/` — `submit-job.sh`, `schedule-job.sh`, `job-status.sh`,
  `magi_tool.py`

**No new MongoDB collections.** Job state lives in `sharedDir/jobs/{pending,logs,status}/`.
Schedule specs live in `sharedDir/schedules/` (existing directory, extended format).

**Build order:**
1. `tool-api-server.ts` (standalone, no deps)
2. `daemon.ts` changes (start server, `runPendingJobs`, `jobSpec` in heartbeat)
3. `cli-tool.ts` + `setup-dev.sh` wrapper
4. `research.ts` extension (`contextFiles`, `previousResultPath`)
5. `run-background/` skill scripts + `magi_tool.py`

**Verification:** `npm run build` clean; start daemon; confirm `magi-tool fetch-url
--params '{"url":"https://example.com"}'` returns a JSON artifact; confirm `submit-job.sh`
triggers pickup at next heartbeat and a completion PostMessage arrives in the agent mailbox.

---

### Phase 4 — Integration test (yfinance + news brief, minimal API keys)

**Test file:** `tests/data-factory.integration.test.ts`

Requires: `ANTHROPIC_API_KEY`, `MONGODB_URI`. Does NOT require FMP, NewsAPI, FRED, GDELT keys.

**Part A — time-series (no LLM, fast):**
1. Provision a test workspace for Lin's linux user
2. Run `adapter_yfinance.py --fetch` for NVDA (as Lin's linux user via isolated Bash tool)
3. Assert: CSV written, ≥1 row, `date` and `close` columns present

**Part B — news brief (needs ANTHROPIC_API_KEY):**
1. Write a fixture `digest.json` (3 hardcoded NVDA article URLs, `is_new: true`)
2. Submit background job via `submit-job.sh`: `magi-tool research --context-file digest.json
   --output brief.md --max-age-hours 0 --question "Update NVDA brief from today's digest"`
3. Poll Lin's mailbox for completion PostMessage (30s timeout, same pattern as Sprint 6b)
4. Assert: `brief.md` written, length > 200 chars, contains "Sources" section header

**Part C — scheduled refresh (optional, extends A+B):**
1. Use `schedule-job.sh` with a cron that fires in ≤1 min from test start
2. Wait for node-cron tick + job completion
3. Assert same as A + B

Skipped when `ANTHROPIC_API_KEY` absent (Parts B, C). Part A always runs.

---

### Phase 5 — Equity research YAML + docs (after integration test passes)

- `equity-research.yaml` — additive updates for all 4 agents
- `OPERATOR_GUIDE.md` + `playbook.json` — Step 2e (data factory bootstrap)
- `CLAUDE.md` — Sprint 12 documentation
- Build + commit

---

## Open Design Decisions

None. All gaps resolved:
- News synthesis uses `Research` extended with `contextFiles` + `previousResultPath` params
  (~30 lines in `src/tools/research.ts`); no new tool; Haiku model; no SearchWeb; cache populated
  normally so agents can later query the same brief without re-running
- `process_document.py` eliminated — FetchUrl reused on-demand from filing index
- Two skills (`data-factory/` vs `data-factory-client/`) — Lin as operator, others as consumers
- `run-background` builds now — scripts run as agent linux user, IPC for LLM tools
- HTTP API (not Unix socket) — container-ready; env var `MAGI_TOOL_URL` is the only thing that changes between dev and Kubernetes; bearer token auth is standard
- Python SDK uses `urllib.request` (stdlib) — no pip install required
- **No new MongoDB collection for background jobs** — job state in `sharedDir/jobs/` spool
  directories (pending/, logs/, status/); scheduling reuses existing `sharedDir/schedules/`
  pattern with an extended spec format (`jobSpec` field alongside existing `to`/`subject`/`body`);
  the `node-cron` heartbeat already fires every minute and re-arms cron entries — no Change
  Stream watcher needed
- Parallel non-FMP adapters via Python threads inside `catalog.py refresh`
- FMP adapters sequential with 200-call/day budget guard
