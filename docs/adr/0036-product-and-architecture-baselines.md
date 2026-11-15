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
| **Intended** | Actors, entities and their states, operations and their rules, journeys (the product); components and their dependency rules (the architecture) | The product owner, who approves every change | The baseline catalog (decision 2) |
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
  is today, shows the index of results and the agent's to-do list.
- **A to-do list the agent cannot ignore.** Each scan emits items that need judgment (an entry
  point without an operation, an operation reached through two implementations, an unexpected
  status write, a stale view). The agent disposes of each as a finding, dismissed with a reason,
  or deferred to a date; nothing disappears unhandled, and dismissals are reviewed.
- **Evidence.** Every name a report cites must resolve in the code (the citation check), and every
  "pass" cites what established it (the `working-agreements` skill).
- **Agents never edit the baseline.** A missing or ambiguous requirement is a finding for the
  product owner.

### 8. The coding agent is held to the same design through `CLAUDE.md`

`CLAUDE.md` and the practices tell the coding agent to:

- give every new entry point the `OperationId` it serves, and call the operation's one
  implementation rather than restating its checks ("One operation, one home");
- treat a new operation, a changed rule or a new component as a baseline change: edit the
  catalog, run `npm run docs:baseline`, and get the product owner's approval in the same piece of
  work, recording an ADR when it chooses between alternatives;
- name the journey or invariant id in a test that verifies one;
- when the code and the baseline disagree, say so, never adjust either to match quietly;
- keep every source file inside a component (the baseline test fails otherwise).

### 9. Gates

- **Requirements gate:** a change to the catalog is proposed (by a reviewer's finding or a
  commit) and approved by the product owner.
- **CI, blocking:** the catalog compiles; ids are unique; every source file is in exactly one
  component; documents are current; every entry point carries an operation id.
- **CI, reported:** operations with more than one implementation, status writes outside the
  intended transitions, dependency-rule violations, journeys and invariants without a test.
- **Release gate** (when the release process exists): the reported checks are clear or each
  remaining item is accepted by the product owner.

### 10. How the documents relate

Each answers one question and cites the others by id rather than restating them:

| Document | Answers |
|---|---|
| Baseline catalog and its rendered documents | What MAGI must do, and the parts it is built from |
| SPEC | How it works: mechanisms, tools, formats |
| ADRs | Why one alternative was chosen; a decision that changes the baseline names the ids it changes |
| Plans | How a piece of work will get there; they propose baseline changes |
| Roadmap | When |
| Implementation history | What happened |
| Threat model, resilience document | Trust boundaries and failure modes, expressed in actors and components |

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
- MAGI DEV's machine grows to about 4 GB for CodeQL, and scans add a scheduled job's cost.
- What stays judgment is explicit: whether a rule's wording is enforced, whether a test proves
  what it names, whether a difference is a bug or a gap in the baseline. The tools narrow where
  to look; the agents and the product owner decide.

## Build order

1. The catalog, its rendered documents and the baseline test. **Done.**
2. Operation ids on every entry point, with their test and the list of known differences.
3. `npm run trace`: the CodeQL query pack, dependency-cruiser rules from the catalog, coupling,
   the code-query wrapper, the analysis index; the CI checks of decision 9.
4. `CLAUDE.md` and the practices updated as in decision 8.
5. MAGI DEV: the larger machine, the scan job, the managed region fed from the analysis index,
   the four-part prompts and mental-map templates, a re-onboarding turn.
6. The to-do list with dispositions, and freshness flags on mental-map entries.
