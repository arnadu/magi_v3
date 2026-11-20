# Traceability — working practice

The root `CLAUDE.md` keeps the one-line triggers; this is the full text. The design is
[ADR-0036](../adr/0036-product-and-architecture-baselines.md).

## The idea

The product baseline ([docs/product/](../product/README.md)) says what MAGI is meant to do:
actors, entities and their states, operations, journeys. The code says what it does. The two
are joined by ids, put in by hand at a few places and checked by machine; everything else
(what each entry point reaches, which code writes a status) is computed by scans.

## Every entry point declares what it serves

An entry point is anything an actor or the platform starts work through: a route, a tool, a
copilot action, a name in the background jobs' Tool API, a timer or change stream, and a
directory where an agent asks by writing a file (jobs, schedules). Each one declares the
**operation** it serves (`mission.launch`, `agent.dispatch`, …), or, when it serves no product
operation, an **entry class** (`infrastructure`, `developer`, `proposal`, `feed`,
`housekeeping`, `retired`). Both lists, and the definitions D1–D10 the catalog is kept by, are
in [operations.md](../product/operations.md). An operation that only another operation starts
names it (`startedBy`) and has no entry point of its own.

| Entry point | Where the tag goes | Checked by |
|---|---|---|
| Tool (agents, both copilots, sub-agents) | `operation:` on the `MagiTool` object | `tsc` (required field) |
| Monitor route (mission machine) | `operation:` on the `RouteEntry` | `tsc` (required field) |
| Control-plane route through `asyncRoutes` | second argument: `routes.get("/x", "mission.status", h)` | `tsc` |
| Control-plane route on a bare router | first handler: `router.get("/x", operation("mission.status"), h)` | the entry-point test |
| Control-copilot action | `ACTION_OPERATIONS` in `copilot-actions.ts` | `tsc` (exhaustive record) |
| Tool API name | `operation:` on its entry in `tool-api-server.ts` | `tsc` |
| Cron, interval, change stream, cooldown | wrap the callback: `schedule("* * * * *", entryTrigger("schedule.deliver", tick))` | the entry-point test |
| File request (a directory an agent writes requests into) | wrap the directory where it is read: `readdirSync(entryFile("job.submit", dirs.pending))`; one directory may serve several operations (`entryFile(["schedule.create", "schedule.cancel"], dir)`) | the entry-point test |

The tag is a type (`EntryTag` from `@magi/agent-config`): a misspelt id fails `tsc`.
`npm run trace:entry-points` lists every entry point with its tag;
`packages/agent-config/tests/entry-points.unit.test.ts` fails on one without a tag, on an id
not in the catalog, and checks the scan itself against planted examples.

## Choosing the tag

- **Pick by intent, not by code path.** Two entry points that ask for the same thing with the
  same rules serve the same operation, even when they reach different code today. Tag them
  honestly; a difference in what they reach is for the scans to report, not for the tag to hide.
- **No operation fits?** Do not stretch the nearest one. Propose a new operation, or an entry
  class, as a change to the catalog (`packages/agent-config/src/baseline/`): the product owner
  approves it. The granularity rule heads [operations.md](../product/operations.md).
- **A timer or stream that only feeds an open route's response** is `feed`; the route declares
  the operation.

## Invariants

An invariant is what must be true at every moment, whoever acts and whatever fails (an
operation's rules hold when someone asks; an invariant holds always). Each one in the catalog
says how it is kept true, in `enforcedBy`:

- **a test** whose title starts with the invariant's id (`it("mission.capped: …")`), at the
  home of the operations that could break it;
- **a scan** (a query in `scripts/trace/ql/`), for "only X writes Y" and allowed transitions;
- **a runtime check** the platform runs, for what only shows while it operates;
- **review**, when nothing else can judge it.

A catalog test fails when a cited test or query does not exist; the trace lists the invariants
nothing enforces yet.

**When an invariant needs an ADR.** Its catalog entry is its record, unless adopting it was a
choice: there were real alternatives, it costs something notable (storage, latency, money,
complexity), or how it is enforced is itself a design choice. Then an ADR records the decision,
the invariant names it in `decidedBy`, and the ADR lists the invariant in `governs`. Related
invariants share one ADR. A decision not yet made is written in the invariant's `open`.

## The trace

`npm run trace` scans the code and joins what it finds to the catalog. It writes to `analysis/`
(not committed):

| Report | Question it answers |
|---|---|
| `index.md` | The headline numbers, and the findings by kind, with what is new since the last run |
| `operations.md` | For each operation: its entry points, whether each reaches the operation's home, the database writes each reaches, the HTTP routes it crosses into, and where reach may be incomplete |
| `writes.md` | Every MongoDB write: its collection, whether its component owns that collection, and for a status the changes it can make against the entity's allowed transitions |
| `security.md` | CodeQL's standard security queries, each result filed under a security invariant |
| `invariants.md` | Every invariant, what enforces it, the ADR that chose it, its open decision |
| `components.html` | The component map: each component on its declared layer, the imports between them, those against the layering |
| `findings.json` | Every finding, with a stable key; `previous/findings.json` is the run before |

Every finding names the baseline id it is about and the `file:line` it rests on. Read a finding
as evidence to check, not as a verdict: confirm it in the code before acting on it.
`scripts/trace/decisions.mjs` keeps the reviewers' conclusions on findings. `about <file or
id>` lists the findings on a subject with the caller's own conclusion on each; `record` records a
reviewer's conclusion on one finding (`finding`, `catalog`, `dismissed`, `reopen`). A conclusion
must cite the `file:line` that establishes it, at one of the places the finding names, and
cannot reuse another finding's reason. Findings are leads, not a list to empty: nothing counts
the ones left unexamined. Another reviewer's conclusion is not shown: a reviewer that sees one
tends to adopt it without reading the code. `sample <n>` draws dismissals for the user to check
against the code; the user's checks stay outside the mission, and a wrong one is taken up with
the reviewer by message, asking what led to it.

**How each part is computed, and its limits.**

- *Entry points*: `scripts/trace/entry-points.mjs`, from the TypeScript syntax tree.
- *Writes*: `scripts/trace/writes.mjs`, with the TypeScript compiler's types. A write's
  collection comes from the receiver's type (`Collection<MissionDoc>`) or from where the
  collection was created. A status value passed in as a parameter is resolved one level up, at
  the function's call sites. A filter on the status (`status: "draft"`, `$ne`, `$in`, `$nin`)
  gives the states a write can start from; no filter means any state.
- *Reach*: CodeQL's call graph (`scripts/trace/ql/`), followed from each entry point's handler.
  A function nested in a reached function counts as reached. A function that holds the path of a
  monitor route or of a mission-copilot gateway route crosses into that route (HTTP hops). Calls
  CodeQL cannot resolve, typically through injected dependencies, are listed with each entry
  point: reach is a lower bound there.
- *Security*: CodeQL's `javascript-security-extended` suite. Its results include false
  positives; each needs triage.

**For one question**, without the full trace (TypeScript language service, seconds):

```bash
npm run trace -- def claimStatus                                   # where it is declared
npm run trace -- refs packages/control-plane/src/mission-claims.ts:19     # every reference
npm run trace -- callers packages/control-plane/src/mission-claims.ts:19 --depth 2
npm run trace -- reach mission.launch                              # from the last trace
npm run trace -- reach mission.launch --analysis <dir>             # from reports fetched elsewhere
```

`callers` follows calls only; a handler registered by name in a table (the copilot's `HANDLERS`)
is found by the full trace, not by `callers`.

**Running it.** `bash scripts/trace/install-codeql.sh` installs the pinned CodeQL release, checked
against its published SHA-256, into `~/.cache/magi/codeql` (`CODEQL_HOME`). A full run takes
about four minutes; `--no-security` skips the security suite, and `--reuse-db` keeps the CodeQL
database for repeated runs on unchanged code.

**In CI** (`quality.yml`), report-only: no deploy waits for it, and it fails only when the tool
breaks. The `trace` job runs the repository's code, so it has no write access to the repository;
it sends CodeQL's security results to code scanning (the repository's Security tab, maintainers
only) and nowhere else, because a possible vulnerability is never described anywhere public: the
run's `trace` artifact and summary carry only their counts. On a push to `main`, the
`trace-publish` job, which runs none of the repository's code, pushes the other reports to the
`trace` branch, one commit per scanned commit. MAGI DEV's scan job fetches them from there (skill
`trace-scan`): the analysis runs on GitHub's machines, not on a mission's shared CPUs, where
CodeQL is throttled into the job's time limit.

## What each change means for the catalog

Some changes are caught by a test or the compiler; the others only show in the trace, or
nowhere. The catalog change is proposed in the same commit as the code, and the product owner
approves it.

| Change | What to do | Caught by |
|---|---|---|
| New entry point | Tag it with its operation or entry class | `tsc`, the entry-point test |
| New intent (a feature) | Catalog first: operation, entity states, journey; then the code | review |
| New source file | Falls under exactly one component's path patterns | baseline test |
| New collection | A data store with its one owning component | baseline test |
| Implementation moved to another component | Change the operation's `home` | trace (`op.home-not-reached`) |
| New database write from another component | Move it to the owner, or change the owner | trace (`store.foreign-writer`) |
| New status value or transition | Add the state and the transition to the entity | trace (`status.*`) |
| Function the catalog names renamed or moved | Update the invariant's `runtime` location | baseline test |
| Journey or operation id renamed | Also in MAGI DEV's template (`config/teams/magi-dev/`) | baseline test (journeys, coverage) |
| Catalog gap closed | Update or remove its row in the roadmap's "Backlog: catalog gaps" | nothing: by hand |
| Planned operation built | Remove `planned` | nothing: by hand |
| New invariant enforced | Name the test, scan or runtime check in `enforcedBy` | baseline test (that it exists) |

**Read the trace before committing** any change in the rows the trace catches:
`npm run trace -- --no-security` (a few minutes), then "new since the last run" in
`analysis/index.md`. CI runs the trace too, but it blocks nothing and nobody reads
it for you.

A runtime location is written `<package path>: <what>`, several joined by `; ` (a bare file
name is in the previous one's folder). When `<what>` starts with function names (camelCase,
comma-separated) or a route path (`/confirm`), the baseline test checks each is still in that
file.

## Changing intent

- A change to what MAGI should do is a change to the catalog first, approved by the product
  owner, then the code. Run `npm run docs:baseline` to regenerate the documents.
- A test that walks a journey or enforces an invariant names its id (`J-04`, `mission.capped`)
  in its title.
