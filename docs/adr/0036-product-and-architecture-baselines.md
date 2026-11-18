# ADR-0036: Traceability between intent and code for an autonomous development team

**Status:** Proposed (2026-11-15). The baselines' format is in place; their content is a draft
awaiting the product owner's approval. The other parts are built in the order given at the end.
**Relates to:** [magi-dev-requirements.md](../plans/magi-dev-requirements.md) ("The application
model"), the code-structure practice ("One operation, one home"), ADR-0003 (the mental map)

## Context

### The goal

MAGI is meant to run an autonomous team of agents across the whole software life cycle of an
application, MAGI itself first: requirements, design, building, review, testing, release and
production support. The first step, MAGI DEV phase 0, is a team that only reviews and documents:
an application security architect, a code reviewer, a documenter and a QA lead. A human (the
product owner) sets the intent and approves what matters; a coding agent (Claude Code, guided by
`CLAUDE.md`) writes the code.

### The problem

Every role in that team does the same thing at its core: compare what the application is meant
to do with what it does, and judge the gap. Its first runs showed that the agents could not do
this reliably:

- **No statement of intent to compare against.** What MAGI should do was spread across the SPEC,
  ADRs, plans, issues and conversations with the product owner, much of it implicit. An agent
  inferred intent from the code, so code that was wrong looked like the requirement.
- **Facts recalled instead of looked up.** Reviewers named functions and files that did not
  exist, and drew conclusions about which code an entry point runs without following the call
  to its definition. These are tracing failures, not failures of judgment: tracing is a tool's
  job, and the agents had no tools for it.
- **Not comprehensive.** An agent reads a sample of a codebase of several hundred files and
  cannot tell what it has not covered. A review that misses an area looks the same as one that
  checked it and found nothing.
- **No memory between runs that stays true.** Each run rebuilt its picture of the application
  from scratch, or kept notes that drifted from the code.

Prompting harder (more rules, more checklist rows after each miss) fits one model's run to the
known answers and does not generalize. The fix is structural: an explicit, versioned statement of
intent; facts computed by tools; and a defined link between the two that a machine can check.

The hard part is that link. Intent is set in conversation with the product owner, in words such
as "a mission is launched only once, even if asked twice at the same moment". Code is functions,
routes and database writes. Nothing derives one from the other automatically.

### What the industry does

- **Requirements traceability** (DO-178C, ISO 26262, IEC 62304; tools such as Doorstop, StrictDoc,
  OpenFastTrack): requirements carry stable ids; the code and the tests cite them; a scanner
  builds the matrix in both directions and reports requirements without implementation or tests,
  and code that serves no requirement. The link is made by a person when the code is written,
  then checked by machine. Mainstream teams use lighter keys: test names, folder structure, an
  OpenAPI `operationId` on each route.
- **Configuration baselines** (IEEE 828, CMMI): an approved, versioned set of requirements and
  design, changed only through change control.
- **Use cases and ports and adapters** (Jacobson; Hexagonal and Clean Architecture): what an
  actor can ask the system to do is a use case with one implementation; each entry point (a route,
  a CLI command, a tool) is an adapter that calls it and adds only access and presentation.
- **Domain-driven design**: entities with lifecycles, a shared vocabulary between the product
  owner and the code.
- **Architecture as code and fitness functions** (C4 components; ArchUnit, dependency-cruiser):
  the intended components and their allowed dependencies, checked against the code on every
  build.
- **Code as data** (CodeQL, language servers): call graphs, reachability and data flow computed,
  not read.
- **Behavioural code analysis** (Tornhill; code-maat): hotspots (churn × complexity) and
  temporal coupling (files that change together) from version history.
- **Test design** (ISTQB): state-transition testing, risk-based depth, the role matrix
  (entity × operation × actor).
- **Docs as code and architecture decision records** (Nygard): documentation versioned with the
  code, generated where it can be; decisions recorded with their alternatives.

### How MAGI adapts it

Regulated traceability tags every requirement down to units of code. That is too heavy for a
small team and still relies on people to keep tags right. MAGI adapts it in five ways:

1. **Anchor at the roots of the call tree, compute the rest.** Only entry points carry a tag (the
   operation they serve). Everything underneath (the code an entry point reaches, whether two
   entry points converge on one implementation, which status writes they make) is computed by
   static analysis on each run, so it cannot go stale.
2. **Keys the compiler checks, not comments.** Ids are TypeScript literal types; a misspelled or
   retired id fails the build. Agents, which do not remember, cannot drift either.
3. **Intent is small and approved.** The baseline holds about 60 items (actors, entities,
   operations, journeys, components), not hundreds of requirements; the product owner approves
   every change.
4. **Agents keep judgment, not facts.** Facts come from the scans and intent from the baseline;
   an agent's mental map holds only its view of the gap between them. There is no third
   description of the application to keep true.
5. **A gap is never resolved by editing either side quietly.** It is a finding against the code,
   or a question for the product owner about the baseline.

## Decision

### 1. Three models, kept apart

| Model | What it is | Owner | Where |
|---|---|---|---|
| **Intended** | Actors, entities and their states, operations and their rules, journeys (the product); components and their dependency rules (the architecture); design decisions and the rules they set (how it must be built) | The product owner, who approves every change | The baseline catalog (decision 2) and the rules of accepted ADRs (decision 10) |
| **As built** | Entry points and their operation ids, the code each one reaches, status writes, dependencies, hotspots, coupling | The scans | Generated on every run (decision 5) |
| **Each agent's view** | Where intended and as built differ through its role's lens, how much it matters, what it has not yet checked | The agent | Its mental map, and nothing else (decision 7) |

### 2. The baselines are a typed catalog; the documents are rendered from it

`packages/agent-config/src/baseline/` holds:

| Element | Holds | Join key with the code |
|---|---|---|
| Actor | Who can ask (operator, admin, the two copilots, agents, jobs, the platform), their authority, how they reach the code | The kind of entry point (a session route, a copilot action, an agent tool, a timer…) |
| Entity | Where it is stored (collection, document type, status field), its states, the intended transitions and who causes each, its invariants with ids | Collection and status field, matched against status writes |
| Operation | Intent, the actors allowed to ask, the rules that hold whoever asks, the component meant to hold its one implementation | The operation id each entry point declares |
| Journey | A sequence of operations an actor completes | The journey id in the name of the test that walks it |
| Component | Responsibility, source path patterns, dependency rules | The file's path |

Ids are literal types: an operation naming an unknown component, a journey naming an unknown
operation, or a transition naming an undeclared state fails `tsc`. `docs/product/*.md` and
`docs/architecture/components.md` are rendered from the catalog by `npm run docs:baseline`, as
`docs/env.md` is from the env catalog. Scripts and tests read the catalog, never the documents;
people and agents read the documents.

### 3. Every entry point declares the operation it serves

Each route, copilot action, mission-copilot tool, agent tool and timer registration carries an
`OperationId`. A test lists the entry points and fails on one without an id. Operations that
today have more than one implementation are recorded on a list of known differences, so the
check holds from the start and the list shrinks as they are merged.

### 4. Tests name what they verify

A test that walks a journey names its id (`J-02`), and a test that enforces an invariant names
the invariant's id (`mission.capped`), as tripwires already carry T-ids. The traceability scan
reports journeys and invariants without a test.

### 5. Facts come from standard tools, run by one command

`npm run trace` runs the scans and writes their results to `analysis/` (JSON for scripts,
markdown for people and agents) with an index of what ran, at which commit, and the headline
numbers.

| Question | Tool |
|---|---|
| Which code does an entry point reach; do two names resolve to one function; does a control-plane call reach a mission-machine route | **CodeQL** query pack: call resolution, reach, route hops |
| Which status writes exist, from which state to which | CodeQL: writes to each entity's status field, joined to its intended transitions |
| Go to definition, find references, call hierarchy, for one lookup | A thin command-line wrapper over the **TypeScript language service** |
| Is every file in one component; are the dependency rules kept | The baseline test (coverage); **dependency-cruiser**, its rules generated from the catalog |
| Where are defects likely; what changes together | Hotspots and temporal coupling from git history, after **code-maat**'s method |
| Dead code, duplication | **knip**, **jscpd** (later) |

Custom code is limited to the operation tags and their test, joining tool results to the
catalog, and delivering results to the agents. CodeQL is free for open-source code; MAGI is
public under Apache 2.0, and that would need revisiting if it went private. It needs a machine of
about 4 GB.

**From query results to reports the agents use.** Raw CodeQL output is rows of code locations.
An agent needs answers organized by what it is responsible for. `npm run trace` turns one into
the other in four steps:

1. **Database.** `codeql database create` extracts the repository at a commit (about 30 s).
2. **Queries.** The pack in `scripts/trace/ql/` emits rows:
   - *entry points*: every route, action, tool and timer registration, with its operation tag and
     its kind, which gives the actor;
   - *reach*: for each entry point, the functions it reaches, with calls resolved through
     interfaces and injected dependencies;
   - *status writes*: every update of an entity's status field, with the collection, the state
     written, the state the update's filter requires, and the enclosing function;
   - *route hops*: control-plane calls to mission-machine routes, joined to their handlers;
   - *rule checks*: one query per ADR rule that CodeQL enforces (decision 10), such as "only this
     operation's home calls that function".
3. **Join to intent.** A script (the custom part) maps every row onto the catalog and the ADR
   rules:
   - a file to its component;
   - an entry point to its operation and actor;
   - a status write to the entity's transitions, using the catalog's list of states to turn a
     filter such as "status ≠ running" into the set of from-states it allows;
   - a rule check to the rule it enforces.

   Each row gets a verdict: as intended, or not, and against which transition, rule or operation.
4. **Reports.** The output is organized by baseline id, not by file:
   - `analysis/operations.md`: per operation, its entry points, the home each reaches, and the
     component;
   - `analysis/status-writes.md`: per entity, every write and its transition;
   - `analysis/decisions.md`: per component, its rules and their results;
   - `analysis/index.md`: when each report ran, at which commit, with headline numbers;
   - `analysis/findings.json`: the rows that differ from intent, those **new since the last run**
     marked.

   Every row carries `file:line` and the call path. An agent can therefore copy a row into a
   report (the citation check passes), or re-run one question on its own:
   `npm run trace -- reach <entry point>` or `npm run trace -- callers <file:line>`.

A call graph is approximate: a dynamic call can be missed, or a false edge added. Rows reached
through an unresolved call are marked as such. A row is evidence to verify, not a verdict to
copy.

### 6. Reconciliation is three questions

Any agent, or a CI job, asks the scans:

1. Does every entry point serve an operation in the baseline, and does every operation have an
   entry point for each actor the baseline allows?
2. Do all entry points of one operation converge on one implementation, inside the component
   the baseline names?
3. Does every status write match an intended transition, and does every intended transition have
   code that makes it and a test?

A "no" is a finding against the code or a question for the product owner.

### 7. The reviewer agents work from the baselines and the scans

- **System prompt in four parts:** the role; how it is judged (recall first: a defect in its area
  found later by someone else is its miss; a wrong "fine" is worse than "not checked"; a current
  view; depth follows risk); its method, named after the discipline (risk-based QA through
  journeys, state machines and the role matrix; code review against the architecture and the
  operations' homes; look facts up, never recall them); and its view of the gap.
- **The mental map holds the view, with a fixed structure.** One entry per part of the baseline
  the role covers, the scan it rests on, what differs, how much it matters, what is unchecked,
  and the commit it was checked at. Section headings come from the template and cannot be edited
  by the agent; the view stays a map (about 1,500 tokens).
- **The platform feeds the scans into the mental map.** A scheduled job runs `npm run trace` into
  the mission's `shared/analysis/`. A managed region, re-rendered every turn as "My objectives"
  is today, shows what is new in the agent's area and how its conclusions held up.
- **Findings are leads, and conclusions are checked.** Each scan emits findings that need
  judgment (an entry point without an operation, an operation reached through two
  implementations, an unexpected status write). The agent looks up the findings on what it is
  reviewing and records what it concluded on each one it examined: a finding against the code,
  a question about the catalog, or a dismissal with the evidence. The product owner checks a
  sample of dismissals against the code; one found wrong goes back to the agent. The findings
  are not a list the agent must empty: in the first runs (2026-11, requirements doc) agents
  given such a list emptied it with dismissals they had not verified, and kept doing so as each
  evidence rule was added.
- **Evidence.** Every name a report cites must resolve in the code (the citation check), and every
  "pass" cites what established it (the `working-agreements` skill).
- **Design rules come with the scans.** For the parts an agent covers, its view includes the ADR
  rules that govern them (decision 10). A broken rule is a finding, and a `review` rule is
  checked whenever the code it governs changes.
- **Agents never edit the baseline or an ADR.** A missing or ambiguous requirement, or a
  decision that no longer fits, is a finding for the product owner.

### 8. The coding agent is held to the same design through `CLAUDE.md`

`CLAUDE.md` and the practices tell the coding agent to:

- give every new entry point the `OperationId` it serves, and call the operation's one
  implementation rather than restating its checks ("One operation, one home");
- treat a new operation, a changed rule or a new component as a baseline change: edit the
  catalog, run `npm run docs:baseline`, and get the product owner's approval in the same piece of
  work, recording an ADR when it chooses between alternatives;
- name the journey or invariant id in a test that verifies one;
- when the code and the baseline disagree, say so, never adjust either to match quietly;
- keep every source file inside a component (the baseline test fails otherwise);
- read the ADR rules governing a component before changing it; never break an accepted rule
  without a new ADR that supersedes it; give every new rule an `enforced-by`, and cite the rule id
  in the code that implements it.

### 9. Gates

- **Requirements gate:** a change to the catalog is proposed (by a reviewer's finding or a
  commit) and approved by the product owner.
- **CI, blocking:** the catalog compiles; ids are unique; every source file is in exactly one
  component; documents are current; every entry point carries an operation id; ADR front matter
  is valid and names only existing ids and checks.
- **CI, reported:** operations with more than one implementation, status writes outside the
  intended transitions, dependency-rule violations, broken ADR rules, journeys and invariants
  without a test.
- **Release gate** (when the release process exists): the reported checks are clear or each
  remaining item is accepted by the product owner.

### 10. Design decisions are part of the intended model

The baseline says *what* MAGI does and which parts it is built from. ADRs say *how* it must be
built and why: "a background job runs as the owner of its spec file", "every mission is created
with a spend cap". These are rules the code must keep and the reviewers must check, as binding as
the baseline. Today they are prose. About 230 source files cite them by habit (`ADR-0033 §3`),
but nothing answers "which decisions govern this code?" or "does each one still hold?". ADRs
therefore become traceable in the same way as the baseline:

- **Front matter.** Each ADR starts with a YAML block in the format of MADR (Markdown
  Architectural Decision Records, the common ADR template), with two added fields: `governs`,
  the baseline ids it applies to, and `rules`, the checkable rules it sets.

  ```yaml
  ---
  id: ADR-0040
  status: accepted              # proposed | accepted | superseded
  date: 2026-12-02
  superseded-by: null
  governs: [cp-machines, cp-mission-ops, mission.archive, mission]
  rules:
    - id: ADR-0040.2
      text: Only mission.archive deletes a mission's volume.
      enforced-by: [codeql:volume-deletes]
    - id: ADR-0040.3
      text: An archive exports the results before it deletes anything.
      enforced-by: [review]
  ---
  ```

  A rule's id is the ADR and its decision number, as the code already cites decisions.
  `enforced-by` names a test whose title starts with the rule id, a tripwire, a CodeQL query in
  the pack, a dependency rule, or `review` when only judgment can check it. `review` is
  allowed: it makes the rule an explicit checklist item for the reviewers instead of a silent
  expectation.
- **Checked like the catalog.** A test parses every ADR's front matter and fails when an id in
  `governs` is not in the catalog, an `enforced-by` reference does not exist, or a superseded ADR
  still lists rules.
- **Rendered index.** `npm run docs:baseline` also renders `docs/adr/README.md`. It lists every
  ADR with its status, plus the reverse index the agents need: from each component, operation
  and entity to the rules that govern it and how each is enforced.
- **In the scans.** `npm run trace` runs the CodeQL queries that enforce rules, and collects the
  places where the code cites each rule. It writes `analysis/decisions.md`: for each component,
  every rule that governs it, how it is enforced, and the result at this commit (holds, broken,
  or review).
- **Who uses it:**
  - *The coding agent* reads the rules governing a component before changing it. A change that
    would break an accepted rule needs a new ADR that supersedes it, approved by the product
    owner. A new rule says how it is enforced.
  - *The code reviewer* gets, for each change, the rules governing the components it touches.
    Enforced rules come with their result; `review` rules are its checklist for that change. This
    replaces the hand-written design checklists in its skills.
  - *The application security architect* gets the rules governing components on a trust
    boundary. The threat model names its boundaries in the same components and actors.
  - *The documenter* checks ADR status and superseded rules against what the SPEC and guides say.
  - *Production support*, for an incident, gets the rules of the components involved. A broken
    rule is a likely cause.

Each document answers one question and cites the others by id rather than restating them:

| Document | Answers |
|---|---|
| Baseline catalog and its rendered documents | What MAGI must do, and the parts it is built from |
| ADRs and their rules | How it must be built, and why one alternative was chosen; the rules the code must keep |
| SPEC | How it works: mechanisms, tools, formats |
| Plans | How a piece of work will get there; they propose baseline changes and new ADRs |
| Roadmap | When |
| Implementation history | What happened |
| Threat model, resilience document | Trust boundaries and failure modes, expressed in actors and components |

## A worked example: archiving a mission

This follows one feature through the whole scheme. Archiving is planned and not built, so the
code, file names, reports and ADR-0040 below are illustrative: the names are invented, and the
exact forms of an operation tag and of the reports are settled in build steps 2 and 3.

### 1. Intent: from a conversation to the baseline

The product owner says: *"When a mission is finished, I want it to stop costing money, but I
still want to read what it produced."*

The coding agent turns that into a proposed change to the catalog (decision 2), and nothing else
yet:

```ts
// operations.ts
{
  id: "mission.archive",
  group: "missions",
  intent: "End a mission: stop all its costs, keep its results readable",
  actors: ["OP", "CC"],          // CC: as a proposal the operator confirms
  home: "cp-mission-ops",
  rules: ["Only a suspended mission", "Final: nothing brings it back to running"],
},

// entities.ts, in the mission entity
states:      [ …, { id: "archived", meaning: "Ended: no costs, results readable" } ],
transitions: [ …, { from: "suspended", event: "archive", to: "archived", actors: ["OP", "CC"] } ],
invariants:  [ …, { id: "mission.archived-is-final", text: "An archived mission never runs again." } ],

// journeys.ts
{ id: "J-17", title: "Stop a mission for good", actors: ["OP", "CC"],
  operations: ["mission.suspend", "mission.archive"] },
```

`npm run docs:baseline` re-renders `operations.md`, `entities.md` and `journeys.md`. The product
owner reads the rendered tables in the commit, not the TypeScript, and approves (the requirements
gate, decision 9). No ADR is needed: nothing was chosen between alternatives.

### 2. Build: the coding agent, held by `CLAUDE.md`

Before writing code, the coding agent reads the ADR index (decision 10) for the components it
will touch: `cp-mission-ops`, `cp-api` and `cp-copilot`. For instance, it reads the rules on how
a copilot action is proposed, confirmed and executed. Following decision 8, it then writes the
operation **once**, in the component the baseline names, and two entry points that call it:

```ts
// cp-mission-ops: mission-lifecycle-actions.ts — the home
export async function archiveMission(db, missionId, requester) { /* checks, effects, failure */ }

// cp-api: an operator route
router.post("/:id/archive", operation("mission.archive"), (req, res) => archiveMission(…));

// cp-copilot: the copilot's action, executed when the operator confirms
{ name: "archive_mission", operation: "mission.archive", execute: (p) => archiveMission(…) }
```

It also writes tests that name what they verify (decision 4):

```ts
it("J-17: the operator suspends, then archives a mission", …);
it("mission.archived-is-final: resume refuses an archived mission", …);
```

The machine catches these mistakes at this stage:

- A typo, `operation("mission.archvie")`, fails `tsc`: the id is not an `OperationId`.
- Forgetting the tag on the copilot action fails the entry-point test (decision 3).
- A new file outside every component's path patterns fails the baseline test.

### 3. Scans: what CodeQL reports

The commit runs CI. The mission's scheduled `npm run trace` (decision 5) runs at the same commit.
The query rows are joined to the catalog and come out as reports organized by baseline id.

`analysis/operations.md` answers questions 1 and 2 of decision 6 for the new operation:

```
## mission.archive  (home in the baseline: cp-mission-ops; actors: OP, CC)
| Entry point                                      | Actor | Reaches                         | Component      | Verdict     |
| POST /api/missions/:id/archive  routes.ts:14     | OP    | archiveMission  lifecycle.ts:212 | cp-mission-ops | as intended |
| archive_mission  copilot-actions.ts:301          | CC    | archiveMission  lifecycle.ts:212 | cp-mission-ops | as intended |
Actors without an entry point: none.
```

`analysis/status-writes.md` answers question 3. The `missions.status` section now has a row it
did not have before:

```
## mission  (missions.status)
| Writes | Filter requires        | In                          | Reached from                   | Verdict |
| archived | suspended            | archiveMission lifecycle.ts:230 | mission.archive (OP, CC)    | suspended → archived: intended |
| running  | status ≠ running     | wakeMachine machine-wake.ts:88  | mission.wake (PLT, scheduler tick) | suspended → running: intended; archived → running: NOT INTENDED (new at 1a2b3c4) |
```

The wake code did not change. The filter "status ≠ running" used to allow only states that may
be woken; a new state widened what it accepts. The join script works this out by expanding the
filter against the catalog's list of mission states. A recurring schedule still falls due for an
archived mission, `mission.wake` starts its machine, and the mission costs money again. No test
of the archive feature shows this, because the archive code is correct. It appears only as a
status write that the intended state machine does not allow.

Because the row is new, it is a new finding in the area of the reviewers who cover the mission
entity. CI reports it too (decision 9).

### 4. Review: the QA lead's view and judgment

The QA lead's managed region (decision 7) shows the latest analysis and what is new in its area:

```
Analysis at 1a2b3c4 (2026-12-01 06:00): operations 33, 0 without an entry point, 2 known
  differences; status writes 41, 1 new difference; rules 58: 3 review-only for changed code.
New since the last scan (1):
  [status-write] mission: archived → running, not intended
    wakeMachine machine-wake.ts:88, reached from mission.wake (scheduler tick). New at 1a2b3c4.
```

Its mental map has an entry for the mission entity:

```
Mission states — checked at 9f8e7d6 against entities.md (mission)
  Scan: status-writes. Differences: none open. Not yet checked: archive (new).
```

It checks the scan before trusting it. It follows the reach path back from the write:

```
$ npm run trace -- callers machine-wake.ts:88
wakeMachine  machine-wake.ts:88
  ← deliverDue  scheduler.ts:140  ← scheduler tick (timer, PLT, mission.wake)
  ← resumeMission  lifecycle.ts:160  ← POST /:id/resume (OP), resume_mission (CC)
```

Then it judges the item against the baseline:

- `archived` has no way out, and invariant `mission.archived-is-final` says an archived mission
  never runs again.
- The rules of `mission.wake` say "wakes a suspended mission". They say nothing about archived
  missions.

So this is a **finding against the code**, not a question about the baseline. Its report quotes
the row and the call path, so every name resolves, and cites the transition and the invariant.
It records its conclusion on the scan's finding as a finding linked to the report, and updates its map entry:
"archive: 1 open finding (a due schedule revives an archived mission)".

### 5. Fix and release gate

The fix goes where the rule belongs: in the home of `mission.wake`, which every caller goes
through ("One operation, one home"), not in the scheduler. The coding agent adds the test
`mission.archived-is-final: a due schedule does not wake an archived mission`. On the next trace
the row reads "suspended → running: intended" and nothing else. The finding is gone, and the
release gate's reported checks are clear.

### 6. Support: when the baseline itself is wrong

A month later, the platform's daily resource report shows storage cost on archived missions. The
production support agent compares this with the baseline:

- the `mission.archive` intent says "stop all its costs";
- it also says "keep its results readable", and the results live on the mission's volume, which
  costs money while it exists.

The code does what the baseline says; the baseline contradicts itself. This is not a finding
against the code, and the agent may not settle it by editing the catalog. It is a **question for
the product owner**, sent with the evidence: the cost figures and the two rules.

The product owner decides that an archive exports the results to cheaper storage, then deletes
the volume. That is a choice between alternatives, and deleting a volume is the riskiest thing
the platform does. So it becomes an ADR with rules (decision 10): ADR-0040, whose front matter is
the one shown in decision 10.
- Its rule `ADR-0040.2` ("only `mission.archive` deletes a mission's volume") is enforced by a
  CodeQL query in the pack, `volume-deletes`. The query lists every call to the Fly API's
  volume-delete and the entry points that reach it.
- Its rule `ADR-0040.3` ("export before delete") can only be judged, so it is marked `review`.

The catalog change and the ADR go through the requirements gate together.

From then on, `analysis/decisions.md` carries the rule for every component it governs:

```
## cp-machines
| Rule       | Text                                              | Enforced by           | At 4d5e6f7 |
| ADR-0040.2 | Only mission.archive deletes a mission's volume.  | codeql:volume-deletes | holds: 1 call, deleteVolume fly-volumes.ts:51, reached only from mission.archive |
| ADR-0040.3 | An archive exports the results before deleting.   | review                | review when archiveMission or fly-volumes.ts changes |
```

Months later, someone adds volume clean-up to the resize path to save money. The row changes to
"broken: 2 calls; also reached from machine.upgrade". That becomes a new finding for the code
reviewer, with the rule, the ADR that set it and the call path, before the change reaches a
mission's data.

### What the example shows

| Stage | Who | Made by hand | Checked or computed by machine |
|---|---|---|---|
| Intent | Product owner, coding agent | The catalog entries | Ids and references (`tsc`), rendered documents (test) |
| Build | Coding agent | The home, the tags, the test names; reading the governing rules | Tags valid and present, files placed |
| Scans | Platform | — | CodeQL rows joined to the catalog and the ADR rules: homes, status writes against transitions, rule checks; new differences become findings |
| Review | Reviewer agent | The judgment: finding or question; verifying the scan | Citations resolve; a decision cites the finding's places; sampled dismissals are checked |
| Fix, release | Coding agent | The fix in the operation's home | The next scan is clean; the gate |
| Support | Support agent, product owner | The question; the decision; the ADR and its rules | Cost figures; the rule check on every later commit |

## Alternatives considered

- **Better prompts and longer checklists.** Tried first; each fix answered the last miss and the
  next run failed differently. It does not give the agents facts or a statement of intent.
- **Agents keep their own model of the application in files.** A third description with nothing
  keeping it true; it drifts from both the code and the intent.
- **Hand-written markdown baselines.** Readable, but scripts would parse tables, and nothing would
  catch a misspelled id in the code.
- **YAML with a schema.** Checked at test time, but ids would not be types, so tags in the code
  could not be checked by the compiler.
- **A requirements tool (StrictDoc, OpenFastTrack, Doorstop).** Built for large regulated
  baselines; another toolchain for about 60 items. Revisit if the baseline outgrows the catalog.
- **Tags on every function.** Heavy, and the tags rot; static analysis computes the same links
  from the entry points.
- **Inferring operations from code with an LLM.** Repeats the failure this ADR addresses: a
  guess, not a fact, with no check.

## Consequences

- Intent becomes explicit and reviewable, and the product owner's role is defined: approving the
  baseline, not reading the code.
- The baselines live in a runtime package. They are types and constants with no runtime effect,
  next to the stored types and the env catalog, so code can import the ids.
- Every entry point has to be tagged once (about 190 today); afterwards the test keeps new ones
  tagged.
- The existing ADRs get front matter once, a rule at a time; until an ADR has it, its rules are
  invisible to the scans, so the most-cited ADRs come first.
- MAGI DEV's machine grows to about 4 GB for CodeQL, and scans add a scheduled job's cost.
- What stays judgment is explicit: whether a rule's wording is enforced, whether a test proves
  what it names, whether a difference is a bug or a gap in the baseline. The tools narrow where
  to look; the agents and the product owner decide.

## Build order

1. The catalog, its rendered documents and the baseline test. **Done.**
2. Operation ids on every entry point, with their test and the list of known differences.
3. `npm run trace`: the CodeQL query pack, dependency-cruiser rules from the catalog, coupling,
   the code-query wrapper, the analysis index; the CI checks of decision 9.
4. ADR front matter, its test and the rendered ADR index (decision 10), starting with the most
   cited ADRs; the rule-check queries; `CLAUDE.md` and the practices updated as in decision 8.
5. MAGI DEV: the larger machine, the scan job, the managed region fed from the analysis index,
   the four-part prompts and mental-map templates, a re-onboarding turn.
6. Decisions on findings, spot checks of dismissals, and freshness flags on mental-map entries.
