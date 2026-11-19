# Catalog review: definitions and day-one content

**For:** the product owner, to approve the operations catalog (`packages/agent-config/src/baseline/`,
rendered in [docs/product/](../product/README.md)) and end its draft status. **State:** approved
2026-11-19, after two rounds of review; applied to the catalog the same day.

## How the catalog is kept

1. **The catalog is maintained by hand.** It states what MAGI is meant to do. Its day-one version
   is built from the existing code, kept consistent with the definitions below.
2. **The product owner decides every edit.** A reviewer raises an edit as a catalog question; the
   coding assistant makes it once approved.
3. **Every push is reconciled against it.** CI's trace compares the code with the catalog. Each
   deviation becomes a finding that a reviewer resolves either as a code fix or as a catalog edit.
   It is closed when the next scan no longer shows it.

The catalog was drafted on 14–16 November from the code, its entry points and the existing
documents, and extended until every entry point had an operation. Some operations exist only
to give code a label, and its definitions were implicit. The reviewers' first catalog questions
all came from those implicit definitions. This review writes the definitions down and applies
them.

## Definitions (proposed)

**D1. Operation.** Something an actor can ask MAGI to do, or a figure it can ask to see
(`read`). It is defined by its intent and its rules (D2). Requests with the same rules are one
operation, whatever their entry point. Different rules make different operations, even on the
same data. Each operation has one home: the code that every entry point serving it calls.

**D2. Rule.** A requirement on how an operation behaves, which its home enforces whoever asks.
A rule is one of four things:
- who may ask ("Only the owner of the mission");
- what must be true first ("Only a draft");
- what the operation does ("The operator is told");
- what happens on failure ("A failure leaves the mission in `error` with its reason").

A rule that applies to one actor only starts with that actor ("AG: its own schedules only").
Rules are the `rules` list of each operation in the catalog. A reviewer checks the home
against them, and each test that enforces one names it.

**D3. Actor.** Whoever reaches an entry point directly. Each actor decides for itself what to
ask:
- the operator (OP);
- the control copilot (CC);
- the mission copilot (MC);
- an agent (AG);
- a **sub-agent (SUB)**: a model loop that an agent's tool starts, acting with that agent's
  identity and budget through a narrower set of tools (Research, BrowseWeb, CreateImage's
  image agent);
- a background job (JOB);
- the platform on a timer or an event (PLT).

An operation lists only the actors that can ask for it.

A sub-agent is an actor, not part of the agent, for three reasons. It makes its own
decisions, and the agent sees only its answer. It reads untrusted content far more than the
agent does. And the catalog has to be able to say which operations it may reach, for example
whether a sub-agent that reads web pages may run shell commands.

**D4. Asking through someone else** does not make you an actor. When an agent gets a bigger
machine by asking the mission copilot, the actor is the mission copilot. A rule records the
path: "AG asks through MC".

**D5. Wider authority is a rule, not an actor.** The platform admin (ADM) uses the operator's
own routes with wider authority. ADM is described in [actors.md](../product/actors.md). In an
operation it appears as a rule ("ADM: all missions"), not among the actors.

**D6. Confirmation is a rule, not an operation.** Some operations need the operator to confirm
them when a copilot asks for them. The operation is still the one asked for (`mission.launch`,
`issue.track`), and it gets the rule "CC: a proposal the operator confirms".

**D7. Entry point.** Every place a request enters MAGI: a route, a tool, a copilot action, a
Tool API name, a timer or event the platform reacts to, and a **file the daemon reads as a
request** (a job in `shared/jobs/pending/`, a schedule in `shared/schedules/`). Each entry point
declares the operation it serves, or an entry class when it serves none. For a file request, the
declaration goes on the code that reads the file.

**D8. A step started only by another operation** declares `startedBy` (its parent) and needs no
entry point of its own. The trace checks that the parent's entry points reach it. It stays an
operation when it has rules of its own, for example a turn's spend and timeout.

**D9. Planned.** An operation the product needs but the code does not provide yet is marked
`planned`. Each deviation the trace reports for it is expected until it is built.

**D10. Journeys** are an actor's goals, end to end: the operator's, and an agent's (for
example: research a question, publish a result, run a background job and use its output). Every
operation an operator or an agent asks for appears in at least one journey. Only the platform's
own operations (PLT) may have none; each of those is checked by its rules.

## Catalog entries the definitions change

Adopting the definitions makes some current entries wrong. This table lists each one and how it
would change. These changes need no separate decision: approving the definitions approves them.
For example, D8 says a step that only another operation starts declares that parent. So
`agent.turn`, which today has no entry point and fails the scan, gets `startedBy:
agent.dispatch`. The workbook (`magi-catalog-review.xlsx`) shows each change on the row it
affects, in the "Proposed change" column.

| Operation | Today | Change | Why |
|---|---|---|---|
| `agent.turn` | PLT, no entry point | `startedBy: agent.dispatch` | D8 |
| `agent.reflect` | PLT, no entry point | `startedBy: agent.turn` | D8 |
| `mission.wake` | PLT, no entry point | `startedBy: schedule.deliver` (the scheduler wakes a machine when work is due) | D8 |
| `machine.upgrade` | actors AG, MC, PLT | actors MC, PLT; rule "AG asks through MC" kept | D4 |
| `mission.set-ceiling` | actors OP, ADM | actor OP; rule "OP up to the platform maximum; ADM above it" kept | D5 |
| `account.usage` | actors OP, ADM | actor OP; rule "OP: their own missions; ADM: all" kept | D5 |
| `copilot.propose` | an operation (CC, MC) | removed; "CC: a proposal the operator confirms" becomes a rule of each operation CC asks for, and `ProposeAction` an entry point that serves the operation of the action it carries | D6 |
| Sub-agents' tools | entry class "sub-agent" (CreateImage's image agent); Research's SearchWeb, FetchUrl and Bash counted as the agent's | actor SUB on each tool a sub-agent can call; the operations they serve list SUB, with rules on what a sub-agent may do (for example whether Research may run `agent.shell`); the entry class is removed | D3 |
| `job.submit` | AG, no entry point | the job runner's reading of `jobs/pending/` is tagged `job.submit` (a code change) | D7 |
| `schedule.create`, `schedule.cancel` | AG has no entry point | schedule ingest's reading of `shared/schedules/` is tagged (a code change) | D7 |

The trace learns `startedBy` and file entry points, so these findings stop appearing.

## Decisions (made 2026-11-18)

1. **`mission.reconcile`** (keep the stored status in step with the machine; decisions Q-09 and
   Q-10). No timer does this today; only the manual script
   `scripts/reconcile-mission-state.mjs` does. **Decided:** marked `planned` (D9), with an issue
   to build it.
2. **`mission.spend`.** **Decided:** both copilots receive regular reports on cost and can explore
   the spend. Whatever is missing is a code gap to fix. Today the control copilot has no tool
   that shows a mission's spend.
3. **`schedule.create` for the operator.** **Decided:** the operator creates schedules through
   the control copilot only. The rule becomes "OP through CC only".
4. **Agents' work.** **Decided:** agents get journeys of their own (D10 changed accordingly). They
   are drafted next, for approval, covering `agent.shell`, `web.read`, `data.query`,
   `image.create`, `cost.allocate`, `job.submit` and the sub-agents.

## Review round 1 (workbook comments, 2026-11-18; decisions 2026-11-19)

The product owner commented on every operation, actor, journey and invariant. The commented
workbook is kept outside the repository; this section records what follows from it.

### Decisions

5. **Copilots are agents with privileged access.** Their basic behaviour is that of any agent;
   they have more power, and the control copilot runs on the control plane's machine rather than
   a mission's. In the catalog, the `copilot.*` operations that repeat an agent operation merge
   into it, and the copilot's differences become rules: `copilot.history` into `agent.history`,
   `copilot.wake` into `agent.dispatch`, `copilot.settings` and `copilot.limits` into the
   operation that changes an agent's configuration. The trace will then report each merged
   operation as having two code paths; which of them become one is a later code decision.
   `copilot.ask` stays: a live conversation whose spend counts against the operator, not a
   mission's mailbox.
6. **Preparing and launching a mission is to be redesigned.** `mission.create` and
   `mission.launch` merge, and the journey is redrafted for approval (draft below) before the
   catalog entries are rewritten.
7. **Both copilots need a shell, with privileges designed first.** Today the mission copilot's
   Bash reaches the platform only as any agent's does (job and schedule files; a job reaches the
   Tool API), and the control copilot's Bash reaches nothing of the platform (its own folder, no
   keys). Giving them more is a security design, recorded in an ADR with a threat-model update
   before any code (open questions below).
8. **One spend operation.** `mission.spend` and `account.usage` become one operation,
   `spend.report`, whose scope (one mission; all of one's missions; all missions for an admin)
   is set by a rule or by the context it is asked in. The cost calculation is implemented once,
   and every place that shows spend uses it.

### Changes accepted as commented

- **Actors:** ADM becomes rules of OP's operations (D5). CC and MC also receive the platform's
  reports and alerts (for the whole platform and for their mission respectively).
- **Operations:**
  - `web.read` splits into searching, fetching and browsing (different rules: browsing runs a
    browser behind the egress proxy).
  - `mission.config` is renamed `mission.read-config`, and `platform.catalog` becomes
    `platform.offerings` (the templates, models and tools offered when creating a mission).
  - Upload and download become operations of their own (today `POST /upload` and
    `GET /download`, counted under `file.write` and `file.read`); `message.send` gains the rule
    "may carry a file the operator uploaded".
  - `agent.turn`'s "report to the supervisor" is written as the rule the code applies: when the
    supervisor's message started the turn and the agent did not answer it, the supervisor is told
    (`agent-runner.ts`).
  - `mission.wake` gains the rule "starts the machine as it is; never moves the mission to a new
    image or config". It is deliberately not `mission.resume`, which restarts on the current
    config and image.
  - `mission.change-config` gains the rule "a change to an agent's mental map waits until that
    agent is paused; nothing else is stopped".
- **Journeys:** J-03 merges into J-02, J-05 into J-04, J-11 and J-12 into one, J-18 and J-19
  into J-08; J-16 splits into uploading for the agents and downloading their work; J-14 becomes
  "give a mission more resources"; J-04 and J-08 are rewritten (J-08: work with the mission
  copilot to understand what the agents did and decide what to change in the configuration).
- **Invariants:** `job.as-author` and `schedule.job-author` become one; `llm-call.bodies-kept`
  merges into `llm-call.recorded`; `objective.tree` and `task.who-updates` become one invariant on
  objectives and tasks; `mission.error-recovery` is dropped (it is `mission.resume`'s rules);
  `mission.way-out` and `mission.status-follows-machine` are reworded in plain terms.

### Code gaps found

- **Configuration changes need a suspended mission.** `PUT /:id/config` refuses unless the
  mission is suspended (`mission-routes-config.ts`), for every change. The catalog's intent is a
  change applied while the mission runs, pausing only the agent whose mental map changes.
- **The control copilot cannot see spend** (decision 2 above), and both copilots' regular cost
  reports are missing.

### Still to do in the catalog

- Entities: check what is missing. Candidates are the things with stored state and a life cycle:
  the user's account, templates, machines and their upgrades, shared files, alerts and daily
  reports, mental maps. The cockpits are components (screens), not entities.
- Operations: map every action in both cockpits to an operation, to find the missing ones.
- The agents' journeys (decision 4).

### Decision 6: preparing and launching a mission (the product owner's narrative, 2026-11-19)

Once signed in, the operator can at once start a new mission by launching a predefined
**template**. A template holds everything needed to start a mission:
- the mission's parameters (models, limits, machine size…);
- the roster of agents;
- the objectives tree;
- for each agent: its system prompt, allocated tasks, initial mental map, tools and skills.

The only thing needed to launch a mission from a template is a unique mission name.

The operator can browse the catalog of templates, each with a unique, informative name, and see
all the configuration it holds. If no template fits, or to get help choosing one, the operator
talks with the control copilot about what the mission is for, and a new template is made for it.
- Either of them can create a template: blank, by cloning a template, or from an existing
  mission.
- Both can edit all of it. The copilot is expected to do most of the editing from the
  conversation; the operator makes tweaks.
- Skills can be copied from any other template or mission, not only the one the template started
  from.

**What it changes in the catalog (proposed):**

- **A new entity, the template.** The draft disappears: what is prepared before a launch is a
  template, and `draft` is no longer a state of a mission. A mission starts at `provisioning`.
- **Operations:**

  | Operation | Intent | Actors | Rules (main) |
  |---|---|---|---|
  | `template.browse` | The templates on offer and everything each holds (replaces `platform.offerings` for templates) | OP, CC | — |
  | `template.create` | A new template: blank, cloned from a template, or from a mission | OP, CC | Unique name; from a mission: only one the requester owns |
  | `template.edit` | Change any part of a template, including copying skills from any template or mission | OP, CC | Validated as a launch would validate it; a write based on an outdated version is refused |
  | `mission.launch` | Start a mission from a template | OP, CC | Only a unique mission name is asked for; the template is copied, so later edits to the template do not change the mission; capped before any machine starts; CC: a proposal the operator confirms |

  `mission.create-draft`, `mission.edit-draft` and `mission.create` are removed.
- **Journeys:** J-02 becomes two journeys:
  - "Launch a mission from a template": the operator alone, `template.browse` then
    `mission.launch`.
  - "Design a template with the control copilot": the operator and the copilot,
    `template.browse`, `template.create`, `template.edit`, `mission.launch`.

**Against the code today, these are gaps:**
- Templates are files in the repository, read-only at runtime, changed only by a deploy
  (ADR-0021, `templates.ts`). User-made, editable templates need a new store and an ADR that
  revises that part of ADR-0021.
- Preparation happens on a draft mission (`CreateDraft`, `EditDraftConfig`,
  `POST /api/missions/draft`).
- No code makes a template from a mission or copies a skill from another template or mission.
- A launch asks for a mission id and a display name.

**Answers (product owner, 2026-11-19):**
- **History.** An early version of MAGI V3 had editable templates. They were cut to read-only
  presets because they took too much time, and drafts have been creeping back towards them. Full
  templates are now needed.
- **Preset templates.** The platform still ships with a few. They stay as files in the
  repository and are loaded into the template store when the platform is installed.
- **Visibility.** For now, every template is visible to and usable by every operator.
- **Launch decouples.** Once launched, a mission is independent of its template. Both stay
  editable, and neither change reaches the other.
- **A template from a mission** carries over all of the mission's configuration and some of its
  files, and its agents' current mental maps, which the operator or the copilot can then edit in
  the template. Conversations are never carried over. Experience shows that much of a mission's
  tuning happens while it runs; this is how it is kept.

**Where the answers left a choice (proposed, accepted 2026-11-19):**
- **Files carried from a mission:** its team files (skills and team documents). The work in
  `shared/` is not carried, unless the requester picks files explicitly.
- **Edits and deletions:** a template is edited in place, without versions. A launched mission
  keeps its own copy, so an edit harms no one. A preset is read-only in the store; to change one,
  clone it. Reinstalling the platform updates the presets. Any operator may edit or delete a
  template they created. Whether other operators may too follows from "visible and usable by
  all" and is to be decided.
- **Names:** template names and mission names are unique across the platform. A mission's id is
  derived from its name.
- **Confirmation:** the copilot creates and edits templates without confirmation, because a
  template runs nothing and costs nothing. A launch by the copilot is a proposal the operator
  confirms.

**Follow-up:** the refactoring is on the roadmap ("Editable templates", near-term candidates).
Its ADR, revising ADR-0021's "Templates" section, is written when the work is scheduled. Until
then the catalog records the template operations as `planned` (D9), and the draft operations stay
as they are, since they describe the code that runs.

### Open questions for decision 7: the copilots' shells

- What each shell needs to reach that the copilot's tools do not already give it, and why a
  shell rather than a tool.
- The identity it runs as: today one OS user for every user's control copilot (TB-15); a shell
  with privileges needs one per user, or equivalent isolation.
- The credential it holds: a token scoped to the copilot's user (control copilot) or mission
  (mission copilot), short-lived, never the admin key.
- Writes: whether a write from the shell needs the operator's confirmation, as a copilot's
  proposals do today.
- Prompt injection: the mission copilot reads every teammate's output, so its shell is where
  injected text could turn into actions; the privileges must assume that.

## Security invariants: enforcement links

Nine security invariants have empty `enforcedBy` lists, so the trace reports them as
unenforced. appsec named the code enforcing each (for example `requireAuth` for
`sec.authenticated`, `resolveInside` for `sec.contained-paths`). The coding assistant verifies
each against the code and fills in the link: the runtime location and the tests that cover it.
No decision is needed beyond approving that work.

## After approval

- The definitions go into the catalog: the operations page's header, and a new `startedBy`
  field in its types (`planned` exists already).
- The changes above are made as one catalog commit, with the trace and tagging changes.
- The rendered pages lose "Draft, awaiting the product owner's approval". ADR-0036 records the
  approval date.
- Any later change follows "How the catalog is kept" above.
