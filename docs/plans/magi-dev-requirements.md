# MAGI DEV — requirements

Status: **draft, under discussion** (started 2026-11-07). Roadmap entry: the "Flagship track —
MAGI DEV" section of [MAGI_V3_ROADMAP.md](../../MAGI_V3_ROADMAP.md).

## Goal

A MAGI mission that runs the whole life-cycle of the MAGI platform: community, planning,
design, development, security, resilience and application support. The end state is an
autonomous mission; the operator sets direction, budget and decision rights, and approves what
the policy says needs approval. It is also the flagship demonstration of MAGI for a software
audience.

Agent capability is not treated as the limiting factor. The work is in the controls (what each
agent may touch, for how long, who approves) and in the skills, team design and schedules that
make agents work well together. Quality is judged by results, as the operator already judges
missions: tests first, CI as the gate, a reviewer that is not the author, approved releases.

## Assumptions

| # | Assumption | Consequence |
|---|---|---|
| A1 | **Mono-tenant.** One installation serves one organization (an enterprise or a family). It runs several teams and users, with no information-security boundary between them. | No per-tenant credential isolation (Sprint 29's CR-04 half), no cross-user privacy, no billing. The shared copilot OS identity (TB-15) becomes an accepted property. A multi-tenant SaaS later would reopen these. |
| A2 | MAGI DEV belongs to the same organization as the users' missions. | Support agents may read users' mission data. It still goes through an audited API, not raw database access: agents make mistakes, and mission content is untrusted text. |
| A3 | **Separate installations.** MAGI DEV runs on its own installation (its own Fly apps and database), not the production one. | MAGI DEV never holds a production deploy credential or database URI. A failure in either installation does not take down the other, and each can watch the other. |
| A4 | Code reaches production only through GitHub: MAGI DEV pushes, CI deploys. | Release control is mostly GitHub configuration: branch protection, required checks, a protected release environment. |
| A5 | MAGI DEV has one or more development and test environments, some inside its own VM, none sharing its database. | Three tiers: in-VM sandbox, staging installation, production. |
| A6 | At-rest encryption against the providers (Fly, Atlas) remains a separate goal (Sprint 29b). | Independent of MAGI DEV. |
| A7 | **The user sets direction and decides; agents configure and operate.** | Every capability is set up and maintained by agents (a manager agent, the copilot) under the governance engine; the user's part is decisions, plus confirmations an external service insists on (such as creating a GitHub App). |

## Topology

```
 MAGI DEV installation (own Fly apps, own DB)              GitHub                    Production installation
 ┌───────────────────────────────────┐   branches, PRs   ┌──────────────────┐ deploy ┌──────────────────────────┐
 │ MAGI DEV mission                  │ ────────────────▶ │ repo: protected  │──────▶ │ control plane + users'   │
 │  ├ in-VM sandbox (build, unit)    │                   │ main, required   │  (CI   │ missions                 │
 │  └ tools via proxies              │                   │ checks, release  │  holds │                          │
 │                                   │ ◀─── alerts ──────────────────────────────────│  Ops API: read tier +    │
 │                                   │ ──── ops calls ─────────────────────────────▶ │  approval-gated actions  │
 └───────────────────────────────────┘                   └────────┬─────────┘ token) └──────────────────────────┘
                                                                   │ deploy
                                                          ┌────────▼─────────┐
                                                          │ staging          │
                                                          │ installation     │
                                                          └──────────────────┘
```

## Platform deliverables

The objectives below reduce to seven platform capabilities. Everything else is mission
configuration (team, skills, schedules) that can be iterated without platform changes.

| # | Deliverable | Content | Existing base |
|---|---|---|---|
| A | **Production Ops API** | A service identity for MAGI DEV, separate from `CONTROL_API_KEY`, with short-lived tokens. A read tier with no approval: mission status and health, anomalies, logs (through the control plane), stats and spend, resource samples, a mission's files and transcripts. An action tier, each action under the governance engine (E): suspend, resume, rollout, rollback, fork a volume, raise a cap. Every call recorded in production's audit log. A push channel: production's hard anomalies and daily report forwarded to MAGI DEV's mailbox through an authenticated inbound endpoint. The single production interface for human operators too. New trust boundary. Design direction: [Production access](#production-access-deliverable-a). | Missions API and copilot actions; anomaly relay; daily report |
| B | **GitHub release control** | The GitHub proxy targets a configurable repository per mission and gains git push (branches only) and pull-request operations. Per-role credentials held by MAGI DEV's control plane, never in agent environments: developers push branches and open pull requests; a release manager tags and requests releases; none can bypass protection. Branch protection on `main`, the existing gates as required checks, and a "production" GitHub Environment whose required reviewer is the operator at first, a policy later. Design: [Source control for project code](#source-control-for-project-code). | GitHub proxy (issues only, one repo, `GITHUB_REPO`); CI gates |
| C | **Staging installation** | A full MAGI stack (control plane, missions app, database) that CI deploys release candidates to. Runs the full integration suite, OS-isolation tests included, and an end-to-end smoke test: launch a test mission, check it runs, resume it, roll it out. | `promote.sh --suffix` named environments |
| D | **In-VM sandbox** | Build, lint, unit tests and lightweight integration tests against a local `mongod`, never MAGI DEV's own database. LLM calls from tests go through a Tool API proxy that speaks the provider API, metered against a test budget; no raw key in the sandbox. A cockpit dev server previewed through BrowseWeb, which needs a sanctioned exception to the loopback block. A bigger default machine shape. | Tool API metering for jobs (`createJobSpend`); machine shapes (28g) |
| E | **Governance engine** | Gates (tollgates) with deterministic triggers at platform chokepoints, typed decision forms with platform-computed facts, deciders assigned by policy with separation of duties, binding single-use approvals, stage enforcement on work items, and a governance section in every agent's prompt and mental map. Not specific to MAGI DEV: any mission can declare gates (a household-finance mission approving payments). Design direction: [Governance engine](#governance-engine-deliverable-e). | Copilot confirmation cards (`ProposeAction`); objectives store write validation; daemon-managed mental-map regions (`#my-objectives`); the `beforeLlmCall` gate; spend ceilings an agent cannot raise |
| F | **Mission rollout and rollback** | A deploy only changes the image for new machines; running missions pick it up on suspend and resume. Production needs a rollout action: canary mission first, health check, then the rest, with automatic rollback. Triggered through A. | In-place resume (#103) |
| G | **External API gateway** | The one way agents reach any external API: connector definitions, platform-held credentials, per-operation policy, approval-bound single-use capabilities, rate limits and budgets, audit, responses treated as untrusted. MAGI DEV reaches A and GitHub (B) through it; so would any mission reaching a bank, a mailbox or a data provider. Design direction: [External API access](#external-api-access-deliverable-g). | Tool API proxies for FRED, FMP and NewsAPI (CR-04); GitHub proxy; `safe-http.ts`; LLM metering for jobs |

Rule for MAGI DEV's own installation: it runs the previous stable release and is upgraded only
after production has run a release cleanly for some days. The operator, or a coding-agent
session, is the emergency fallback if MAGI DEV breaks itself.

## Production access (deliverable A)

**This is the industry's normal pattern, not an agent-specific design.** Mature online services
converge on three practices, whoever does application support:

1. **No standing access.** People sign in through the identity provider and receive credentials
   that last minutes or hours. Elevated roles need a request and an approval, and expire on their
   own. Long-lived personal keys and shared admin secrets are anti-patterns. Examples: AWS IAM
   Identity Center, Azure Privileged Identity Management, Teleport, HashiCorp Boundary, SSH
   certificates instead of keys.
2. **Predefined, audited actions instead of raw access.** Routine operations (restart, roll
   back, resize, rotate a key) are named runbook actions with typed parameters, permissions and an
   audit trail: Rundeck, AWS Systems Manager, internal admin tools, the deploy pipeline. A shell or
   database console on production is break-glass, logged and reviewed.
3. **Broad read access, narrow write access.** Dashboards, logs and traces are open to the
   support team; actions are not.

Service-to-service calls use workload identity instead of stored secrets. For example, GitHub
Actions proves its identity to a cloud provider with a short-lived OIDC token.

**The same mechanism serves human operators and agents.** The Ops API is the single production
interface for both: people through the cockpit and CLI, MAGI DEV through G. The principles are
shared; the threats and the substitute for human judgement differ:

| | Human operator | Agent |
|---|---|---|
| Who holds the credential | The person, on their own device, protected by MFA | The platform; the agent calls a proxied tool and never sees the token |
| Main threat | Phishing, a stolen laptop, mistakes under pressure | Prompt injection through what it reads (logs, users' mission data, community posts); mistakes at machine speed |
| Substitute for seniority | Role, seniority, on-call rota | The governance engine (E) and a track record |
| Unforeseen situations | Break-glass access, rarely used | Break-glass stays human, at least at first; the agent is limited to predefined actions |
| Volume | A few actions per incident | Possibly many: rate limits and per-action budgets |
| Accountability | The named person | The agent, its mission and the approving operator, recorded together |

Data read from production must never be able to authorize an action. Approval happens outside
anything the agent reads, which is why actions are predefined, typed and confirmed.

**Requirements:**
- **Identities.** People use their sign-in token (Firebase ID tokens already last an hour and
  refresh) plus a role. MAGI DEV uses a workload identity, ideally with no stored secret.
  Fly can issue OIDC tokens to machines, which would let production verify the caller is MAGI
  DEV's machine; to be confirmed.
- **Read tier.** A token of about an hour, renewed automatically.
- **Action tier.** An approval produces a single-use capability bound to one action and its
  parameters, valid for a few minutes. It cannot be reused, widened, or pointed at another
  mission. The same applies to a person requesting an elevated action.
- **Break-glass.** `CONTROL_API_KEY`, today a long-lived, all-powerful shared secret used for
  routine work, becomes break-glass only: kept, rarely used, every use alerted. Per-mission
  monitor tokens gain an expiry (#67).
- **One audit log.** Who acted (person, or agent and mission), who approved, what changed, the
  outcome.

## External API access (deliverable G)

Production access is one case of a general need: agents calling APIs outside the platform with
a credential the agent must not hold, under rules the operator sets. The same need appears in
MAGI DEV (the production Ops API, GitHub, social channels, a status page), in research missions
(data providers, already proxied for FRED, FMP and NewsAPI after CR-04), and in personal
missions (a bank, a mailbox, a calendar). G is the one mechanism for all of them. It also
absorbs the post-MVP secret registry and the remaining CR-04 work, and replaces each proxy
being hand-built.

**Two sides.** A is a *server* MAGI builds in production. G is the *client* side in every
installation, used for A and for any third-party API. MAGI DEV calling production goes through
G on the MAGI DEV installation and arrives at A on the production installation.

**A connector** is declared in configuration, never opened by an agent at run time:
- the endpoint and the egress rules (`safe-http.ts` pinning; no redirects outside the host);
- **an operation catalog** with typed parameters, each operation marked read or action. The
  agent's tools are generated from it. Free-form requests are not offered;
- **the credential type**:
  - a static API key;
  - OAuth 2.0 with the user's consent (mail, calendar, a bank);
  - workload identity (OIDC);
  - a token minted per session;
- which agents or roles may use which operations.

**The gateway does, for every call:**
1. **Custody.** It holds the credential, refreshes it, and attaches it to the request. Agents and
   their subprocesses never see it.
2. **Identity.** It records the calling agent and mission.
3. **Policy.** It asks the governance engine (E) whether the operation is autonomous, notify-after or
   approve-first.
4. **Approval.** Approve-first operations wait for a confirmation that yields a single-use
   capability bound to the parameters.
5. **Limits.** Rate limits and a budget per connector, operation and agent, including money
   for paid APIs.
6. **Audit.** Request, parameters, approver, outcome, and the response size or digest.
7. **Untrusted response.** The response is wrapped as untrusted content before it reaches the
   agent, and is size-capped.

**MCP.** Connectors can be MCP servers: the industry's standard way to expose tools to agents,
and many APIs already ship one. MCP standardises the tool interface but not custody, policy,
approval or audit. G is the layer that wraps an MCP server so agents can use it safely.

**Credential storage** is where G meets Sprint 29's at-rest encryption: platform-held secrets
need encryption the providers cannot read. In a mono-tenant installation this is the main
remaining reason for that work.

## Governance engine (deliverable E)

### What human organizations already do

| Human organization | What it does | Transposed to MAGI |
|---|---|---|
| Policy manual | States which decisions need whose sign-off | A versioned policy file: gate definitions, triggers, forms, decider assignments, thresholds |
| Delegation-of-authority matrix | Who may decide what, by amount or kind | Decider assignment rules per gate, with escalation levels |
| Decision forms | Establish the facts that place a decision in the matrix, and present them in a format the decider knows | Typed forms per gate; facts computed by the platform, judgement supplied by the requester |
| Stage-gate (tollgate) process | Work cannot pass a stage without sign-off | Work items with stages; the transition through a gate needs a decision record |
| Change management (ITIL) | **Standard** changes pre-approved; **normal** changes reviewed by a change advisory board; **emergency** changes expedited, then reviewed | Autonomous (a pre-approved catalogue), approve-first (agent committee or operator), emergency path with mandatory review afterwards |
| Change advisory board | A committee reviews significant changes | An agent committee: different roles and, ideally, different models |
| Segregation of duties | Whoever requests or performs cannot approve | Requester and decider are different agent identities, enforced |
| Delegation letter | Authority granted for a scope, an amount and a period | An authorization bound to a work item: paths, budget, expiry |
| Signature or stamp | Proof of approval | A decision record plus a single-use capability bound to the exact artefact version or parameters |
| Job description, training, code of conduct | People know the rules before they act | The governance section of each agent's system prompt and mental map |
| Internal audit | Checks after the fact that the rules were followed | The auditor agent, plus the operator sampling agent-approved decisions |

### Five parts of a gate

| Part | What it is | Where it lives | Can the requesting agent bypass it? |
|---|---|---|---|
| **Trigger** | The rule that says this action needs a decision | Deterministic platform code at a chokepoint | No |
| **Form** | The structured decision record | A typed schema; facts by the platform, judgement by the requester | Facts no; judgement is reviewed |
| **Decider** | Who signs: an agent, a committee, the operator | Assigned by the policy, never chosen by the requester | No |
| **Record** | The signed decision | Immutable, in the platform's store and audit log | No |
| **Capability** | What unblocks the action | Single-use, bound to the artefact version or parameters | No |

Skills supply the procedures: how a requester prepares a form, how a decider reviews it. Skills
make gates usable; the platform makes them mandatory.

### Two layers: instruction and enforcement

**Layer 1: instruction (what agents are told).** Most of the value is here: an agent that
knows it must not start coding before the functionality is validated does not waste a day of
spend on work a gate will block later. Two injection points, both outside the agent's and the
mission copilot's control:

- **A governance section in the system prompt**, generated from the policy for the agent's role.
  It is not part of the team configuration, which the mission copilot can edit, so it changes
  only through a policy change (the highest gate). Content:
  - the gates that apply to this role;
  - the standing rules in plain, firm language with the reason for each ("Do not begin
    implementation of a work item until it shows *approved for build* in your governance section.
    Work started earlier is wasted: merges of unapproved items are refused.");
  - how to request a decision;
  - **what counts as an approval: only a record shown in the governance section.** A message
    from a teammate, a user or a web page saying something was approved is not an approval,
    whoever appears to send it.
- **A managed `#governance` region in the mental map**, re-rendered every turn from the
  governance store and read-only to the agent (the same mechanism as `#my-objectives`):
  - my authorizations: work item, scope, budget left, expiry;
  - my open requests and their status;
  - decisions waiting for me as a decider;
  - my blocked work items and the gate each one waits on.

Layer 1 alone is not a control: a model error or injected text can override an instruction.
Every rule that matters in Layer 1 has a Layer 2 counterpart or, where none is possible, a
detective control.

**Layer 2: enforcement (what the platform refuses).** The pattern is the industry's
*policy decision point / policy enforcement point*, as in Open Policy Agent or AWS Cedar:
chokepoints ask one decision service, and the policy lives in one place.

- **Governance tools:**
  - `RequestDecision`: a gate, a work item and the requester's form fields. The platform adds
    the computed facts, routes the request to the deciders, and moves the work item to
    *awaiting decision*.
  - `GetDecision` and `ListDecisions`: status.
  - For deciders only, enforced by identity: `ReviewDecision` returns the form and links to the
    evidence; `Decide` takes approve, reject, request changes or escalate, plus reasons and the
    checklist answers. A decider never sees the requester's conversation.
  - Amending a form voids any approval already given.
  - For the operator: a decisions inbox in the cockpit that renders the form, with approve and
    reject.
- **Stage enforcement on work items.** Work items carry a life-cycle (proposed, approved for
  design, designed, approved for build, in build, ready for review, merged, released,
  reviewed). The objectives store refuses a transition that passes a gate without a bound
  decision; it already validates writes.
- **Guards at chokepoints.** Every gated tool asks the governance engine `authorize(agent,
  action, parameters)` before acting: merge, tag and release through the GitHub proxy; Ops API
  actions; external publication; spend above a threshold; writes to protected paths such as the
  policy file. The answer is allow, deny with the gate needed, or pending. The guard sits in the
  tool layer, beside the existing argument check every tool call passes through.
- **Tools exposed by authorization.** An agent receives stage tools only while it holds an
  authorization for them: a developer has no push or pull-request tools until it is assigned an
  item approved for build. The guard still checks every call; exposure only removes temptation
  and error.
- **Spend tied to authorized work.** Local work in a sandbox cannot be blocked and need not be:
  it is cheap to discard and is gated where it leaves the sandbox (push, merge, publish). Its
  cost can be. An agent declares the work item it is working on (`SetCurrentWorkItem`); the
  existing `beforeLlmCall` gate refuses further LLM calls when that item has no authorization
  or its budget is spent.
- **Detective controls** where nothing can be blocked: the auditor agent looks for work outside
  any authorization, such as commits on branches not linked to an approved item, or spend
  attributed to no item. Metrics per gate (approval and rejection rates, time to decision,
  outcomes such as rollbacks traced back to the approval) show rubber-stamping and gates that
  are only paperwork.

### Rules

- **Triggers use facts the platform knows** (action type, target, files touched, cost,
  affected missions, test results), never the requester's own classification. Where judgement
  is unavoidable, the default is conservative and the classifier is independent of the
  requester. A requester may escalate upward, never classify downward.
- **Aggregate thresholds** as well as per-action ones (spend per work item per week, changes
  per day), so splitting an action does not slip under every threshold.
- **Default deny on silence.** An undecided request stays blocked, with reminders and then
  escalation. Nothing is approved by timeout except standard changes, which were pre-approved.
- **Emergency path.** Expedited approval by a smaller authority, with a mandatory review
  afterwards.
- **An agent decider approves only within its delegated authority**; above it, it escalates.
  Committees are described below.
- **The platform provides the mechanism; the mission provides the policy.** Which gates exist,
  which escalate to the user, and the catalogue of pre-approved standard changes are
  mission-specific policy, not platform code. The platform ships templates and defaults.
- **No cap on escalations to the user.** If the user is asked too often, the user changes the
  policy.
- **The policy is data, and changes to it go through the policy.** The copilot may change the
  policy, subject to whatever gates the policy places on policy changes. The policy set when the
  mission is created states who may change what. Every change is versioned and recorded. Rules
  are unit-tested, and a simulation mode replays past actions to show what would have been
  gated.
- **Platform invariants**, the only rules not left to policy:
  1. no action reaches a chokepoint without asking the engine;
  2. a requester never decides its own request;
  3. a change that loosens a gate governing the changer cannot be approved by the changer
     alone, so the copilot cannot remove its own gates in one step;
  4. every decision and every policy change is recorded.
- **Delegation loosens on evidence.** When a gate's record supports it, the policy moves it from
  user approval to an agent committee, or from a committee to a standard change. An incident can
  move it back.

### Committees

**How human committees work.** A committee has:
- a **charter**: its scope and authority;
- **members** with roles: a chair, members, often a secretary;
- a **quorum** and a **decision rule**: unanimity, majority, consent ("no objection"), or the
  chair decides after consultation;
- **recusal** for conflicts of interest;
- a **pre-read**: the paper the decision is made on;
- **minutes** recording the decision, the reasons and any dissent;
- **escalation** on deadlock;
- a **cadence**: a standing sitting, such as a weekly change advisory board that batches
  decisions, or an ad-hoc meeting for urgent ones.

Decisions are taken either in a meeting (deliberation) or by **written resolution**: the paper is
circulated and members sign or object independently.

**Transposed to agents.** A committee is declared in the policy:
- members: agent roles, the user, or both;
- the chair;
- the quorum and decision rule;
- the time allowed and the escalation on silence or deadlock;
- the sitting mode: ad hoc per request, or batched on a schedule.

The requester and the author of the artefact are recused automatically.

**Three decision modes:**
1. **Written resolution (the default).** Each member reviews the form independently and returns
   a vote, reasons and checklist answers, without seeing the others' votes. LLMs anchor strongly
   on what they see first, so independence is what makes several reviewers worth more than one.
   The engine applies the decision rule. Members review in parallel, so the cost is that of a
   few single reviews.
2. **Deliberation, when votes disagree or a member asks for it.** The engine circulates all
   votes and reasons; each member may revise once; the chair writes the synthesis. The number of
   rounds is bounded (two at most) to bound the cost. Then the rule applies, or the decision
   escalates.
3. **Advisory committee, the decider decides.** Members advise and the chair, often the user,
   decides. This is how the user sits on most committees (below).

**How a member reviews.** A review runs as a **scoped sub-session**, as the `Research` tool's
sub-loop does today: the member's role prompt, the form, the review skill's checklist and
read-only evidence tools, but not the member's own ongoing conversation. That keeps reviews
cheap, keeps the member's working context free of other work, and keeps text from one work item
out of another's context. The verdict is recorded with the decision; the member's mental map
receives a one-line note.

**Sizing to risk.** One reviewer for low-risk gates, three for high-risk ones. Each decision has
its own LLM budget, charged to the work item.

**Dissent is kept.** Minority opinions are part of the record. The post-implementation review
(G5) compares outcomes with each member's vote, which gives every reviewer a track record and
shows which reviews add value.

**Committees with the user:**
- **User as chair of an advisory committee** (the common case). The agents review first and
  produce one brief for the user: the recommendation, the votes, the dissent and the risks, in
  the format of the gate's form. The user decides with the case already analysed.
- **User as one member**, with a rule such as "the user plus a majority", or a user veto.
- **User as the escalation target** on deadlock, or above the committee's authority.
- The user decides asynchronously from the cockpit's decisions inbox, and can ask questions on
  the decision thread before deciding; the copilot answers from the record and the evidence.
  Requesting changes sends the form back to the requester and voids the votes.
- **Batched sittings** suit the user: non-urgent decisions gathered into a daily or weekly
  sitting; urgent ones ad hoc.

### Existing governance to refactor into the engine

The copilots already carry the beginnings of this. When the engine is built, these become
policies and gates instead of separate mechanisms:
- the control-plane copilot's `ProposeAction`: typed action schemas, a pending action, operator
  confirmation, atomic claim, re-validation at execution (`copilot-actions.ts`);
- `file_github_issue`: provenance prefix, forced label, daily cap;
- the mission copilot's same-turn audit copies of every mutating tool to the user, and the
  missing confirmation for its pause, resume and schedule-cancel actions (CR-07 remainder,
  F-026);
- spend caps and ceilings: the default cap, the platform ceiling, only an admin may exceed it
  (ADR-0034); the copilot's own spend cap and turn time limit;
- machine upgrades: the mission copilot decides, within a 60-minute window and a 24-hour
  cumulative cap with an operator reset (ADR-0031);
- schedule rules: the 5-minute cron floor, recipients on the roster, a job schedule names only
  its author.

**The copilot's confirmation cards are refactored, not kept beside the engine.** Today a
`ProposeAction` produces a card with a Confirm button in the copilot chat. Under the engine, each
action type becomes a gate in the default policy, its zod schema becomes the gate's form, and the
pending action becomes a decision request shown in the decisions inbox (below). The chat card
becomes a pointer to the inbox, with no buttons. The atomic claim and the re-validation at
execution carry over as the engine's single-use capability. The other items above become
policy entries the same way.

### How the user takes part: the decisions inbox

**Why the chat card is not enough.** A card has room for a title and a payload, not for the case
(facts, recommendation, votes, dissent, risks, evidence). It scrolls away with the conversation.
It exists only in the control-plane copilot's chat, so a decision about a mission is taken
outside that mission's cockpit (#87). And it invites approving from a truncated view.

**One component in two places:**
- a top-level **Decisions** view, with a count badge in the header: everything waiting for the
  user, across missions and both copilots;
- a **Decisions** tab in each mission's cockpit: the same component filtered to that mission.

**Layout: the queue on the left, the case on the right.**

```
┌ Decisions (3 awaiting you) ────────────┬────────────────────────────────────────────────────┐
│ ▸ G3 Release v0.42 · magi-dev · 2h  ⚑  │ Release readiness: v0.42                     G3     │
│   Resume meteo · meteo · 5m            │ You are asked: approve release to production?      │
│   Publish blog post · magi-dev · 1d    │                                                    │
│                                        │ Recommendation: approve (committee 2–1)            │
│ ─ Decided ─────────────────────────    │  ✓ release-manager  ✓ architect  ✗ security:       │
│   G1 Ops API design · approved · 3d    │    "rollback untested on volume forks"             │
│                                        │                                                    │
│ Filters: awaiting me · committee ·     │ Facts (verified by the platform)                   │
│          decided · mission ▾           │  14 PRs · staging e2e ✓ · cost $38/$50 · 3 missions│
│                                        │ Risks · Rollback plan · Evidence → (Files, Trace)  │
│                                        │ Thread: questions and answers                      │
│                                        │ [Approve] [Request changes] [Reject]   comment…    │
└────────────────────────────────────────┴────────────────────────────────────────────────────┘
```

**The case, in the order a decision-maker reads it:**
1. the question being asked;
2. the recommendation, and the committee's votes with any dissent;
3. facts, visibly marked as verified by the platform, separate from the requester's claims;
4. risks, rollback plan, and links into Files, Transcripts and Trace;
5. a thread of questions and answers.

**The decision bar.** Approve, request changes (returns the form and voids the votes) and reject.
A comment is required for the last two. Conditions on an approval are structured and enforceable
by the platform (a lower budget, a shorter expiry), never free text.

**The chat's role.**
- **It alerts.** The copilot posts which decisions are waiting, with links that open them in the
  inbox.
- **It discusses.** A "Discuss with copilot" button opens the chat with the decision in context;
  answers can be posted to the decision thread.
- **It does not decide.** One place to decide means the full case is always seen first, and there
  is one approval path to secure.

**Security.**
- **The decision is bound to the version seen.** An approval carries the version of the case on
  screen. If the requester amended it after the page loaded, the server refuses and asks for a
  reload.
- **Step-up sign-in.** The policy can require a recent sign-in for high-risk gates.
- **Every decision is recorded** with the user's identity, the version and the comment.

**From the start:**
- **Batched sittings.** A sitting mode steps through the queue. Bulk approval only for items the
  policy marks eligible.
- **A mobile layout.** This view comes first for #57; approvals will often be made from a phone.
- **Out-of-band alerts** for urgent decisions (email or phone push), sharing the channel of G-5's
  alerting.
- **A searchable history** of decisions, feeding post-implementation reviews.

**A first step ahead of the engine.** The inbox can be built now over the existing pending
actions. That replaces the chat cards, closes #87, and gives the engine its UI ready-made.

### MAGI DEV's initial gates

| Gate | Trigger (enforced at) | Decider at first |
|---|---|---|
| G0 Intake accepted, budget allocated | Work item created with a budget (objectives store) | Planning agent within a budget envelope; operator above it |
| G1 Design approval | Move to *approved for build*; an ADR or threat-model update is required when the change touches defined areas | Architect agent plus a security reviewer; operator for a new trust boundary |
| G2 Ready to merge | Merge through the GitHub proxy | A reviewer agent that is not the author, plus green CI |
| G3 Release readiness | Release requested | Release-manager agent plus staging results; operator at first |
| G4 Production rollout | Rollout action on the Ops API | Canary health; operator at first |
| G5 Post-implementation review | Release plus N days | Planning agent; reported to the operator |
| Outside the life-cycle | External publication, spend above a threshold, production actions, security exceptions, policy changes | As set in the policy |

### Decided (2026-11-08)

- Committees are not required to use different models.
- User-level gates and the catalogue of standard changes are mission policy, not platform code.
- No cap on escalations to the user.
- The copilot may change the policy, subject to the policy's own gates on policy changes.

### Open questions

- The policy format, and how a mission's initial policy is authored (a template per kind of
  mission, adapted by the copilot with the user).
- How a member's review sub-session is budgeted and timed out, and what happens to a decision
  whose reviewer fails.

## Objectives and their technical requirements

In the lists below:
- **[exists]** means it is in the platform today;
- **[partial]** means part of it is there;
- **[new]** means it needs building.

Letters refer to the deliverables above.

### Cross-cutting

- **Decision rights** (E) [partial].
- **Proxied access to every external system** through G: agents never hold raw credentials [partial].
- **Budget accounting per deliverable.** Objectives carry `budgetUsd` and a cost-allocation bucket. Agent turns need tagging with the task they serve, so actual spend per deliverable can be compared with its budget [partial].
- **Untrusted input.** Content from outside (community posts, users' mission data) never directly triggers a write [partial].
- **Independent oversight.** The post-MVP auditor agent, brought forward [new].
- **Organizational memory.** Mental maps, the repo's docs and ADRs [exists]. Document search over the repo once the codebase outgrows context [new, post-MVP RAG].

### 1. Promotion and community

- **Channels.** GitHub Discussions, a forum or Discord, social posts, a blog or site, a newsletter. Each needs read and post connectors [new].
- **Publishing gate** (E) [new]. Brand and voice guidelines as a skill [new].
- **Content calendar** on schedules [exists].
- **Assets.** Illustrations (image generation) [new]; screenshots and demo captures through BrowseWeb [partial]; charts [exists].
- **Moderation** and code-of-conduct enforcement on inbound content [new].
- **Community metrics** (stars, downloads, active users, engagement), gathered on a schedule [new].
- **User documentation and onboarding guides** [partial].

### 2. Intake, prioritization, roadmap and budget

- **Intake** from every channel into one backlog: duplicates merged, related reports clustered. GitHub issues and the objectives store exist [partial].
- **Scoring model** as a skill: user demand, strategic fit, estimated cost (LLM spend plus infrastructure), risk [new].
- **Budget ledger** of planned against actual spend per deliverable [partial].
- **Roadmap and plan** artefacts with a cadence: weekly planning, monthly review, operator sign-off on the roadmap [partial].
- **Feedback loop.** Release, measure usage, revise priorities; depends on product analytics (8) [new].

### 3. Design

- **Artefacts:** ADRs, spec, threat model, FMEA, code-structure inventory [exists as practices and skills].
- **UX mockups and clickable prototypes.** Needs image generation, the HTML preview in Files, and the sandbox preview (D) [new].
- **Design review** by a reviewer agent that is not the author, plus operator sign-off above a threshold (E) [partial].

### 4. Development, source control, testing, release

- **Source control.** Branch per change, pull requests, protected `main`, per-role credentials (B) [new].
- **Supply chain.** Lockfile, audit, pinned versions [partial].
- **Test tiers.** Sandbox (D), staging (C) [new]. Evaluation harness for agent behaviour (#45) [new].
- **Pipeline.** The existing gates (verify, tripwires, ratchets, SAST, secret scan, dependency audit) [exists], made required checks on pull requests (B) [new].
- **Code review** by an agent that did not write the change [new skill]. Author-reviewing-self was a root cause in the October 2026 audit.
- **Release.** Staging, then beta, then production. Versioning, changelog, rollout and rollback (F) [partial].
- **Merge policy.** The operator merges at first; policy-based auto-merge for low-risk changes later (E) [new].

### 5. Security

- **Threat model, findings tracker, periodic audits** [exists as skills: security-review, security-audit, threat-model, sprint-audit].
- **Dependency, secret and static scanning** [exists in CI].
- **Least privilege per agent role; audit log of every privileged action** (A, B) [partial].
- **Separation of duties.** The agent that writes a change cannot approve or deploy it (B, E) [new].
- **Responsible disclosure** intake (a private channel and `SECURITY.md`) and a security incident runbook [new].
- **Key rotation** runbooks [partial].
- **Prompt-injection defences** plus the auditor agent [partial].

### 6. Resilience

- **FMEA upkeep** [exists as practice and skill].
- **Service-level objectives and error budgets** [new].
- **Drills:** rehearsed restores (#70), provider-outage and capacity drills such as #103 [new].
- **Backup verification** on a schedule [new].
- **Capacity planning** from resource trends; the daily report has the data [partial].
- **Dependency failure plans:** LLM provider fallback, degraded mode [partial].
- **Mutual watch.** MAGI DEV probes production from outside; an external uptime check watches MAGI DEV (G-5) [new].

### 7. Application support

- **Observability** through A: logs, LLM call traces [exists], metrics [partial], alert routing to MAGI DEV and the operator [new].
- **Troubleshooting** through A's read tier [new]. Runbooks as skills: incident-triage, mission-recovery and disk-pressure exist [partial].
- **Remediation** through A's action tier under E [partial; the actions exist as copilot actions].
- **Resource management:** spend caps, daily report, machine upgrades [exists].
- **Backups:** Atlas backups and 30-day volume snapshots [exists]; restore runbook (#70) [new].
- **User support:** requests about failed missions or how to do something. Reading a user's mission data goes through A [new].
- **Incident communication:** status page and post-mortems [new].

### 8. Product management and analytics

- **Usage events** per feature and per team; dashboards; release impact [new].

### 9. Running costs and providers

Mono-tenant (A1), so there is no billing.

- **Cost-to-serve per installation and per team** [partial; the data mostly exists].
- **Watches on provider accounts and quotas** (Fly machine limits, Atlas storage, LLM credit) and on model deprecations and price changes [partial].

### 10. Legal and compliance

- **Licence** and contributor agreements (Apache 2.0 and CLA exist; enforcing the CLA is not wired).
- **Dependency licence scan** in CI [new].
- **Terms and privacy policy** for any public-facing service [new].
- **Data retention** rules [new].

### 11. Governance of the mission itself

- **Decision rights** (E) [new].
- **Weekly report to the operator:** decisions taken, spend against budget, open escalations [new skill].
- **KPIs for the mission:** throughput, cost per deliverable, escaped defects, response times [new].
- **Pause** [exists]. Rollback of anything done autonomously [partial].

## Source control for project code

**Two git mechanisms, kept apart.** The existing workspace git is a provenance trail for
`shared/`: owned by the daemon, committed after every turn, hardened against agent-planted hooks
and config (`safe-git.ts`); agents never run git on it. It stays as it is. Project code is a
second mechanism: developer agents use git themselves in their own folders, as human developers
do, and integrate through a shared GitHub repository.

**What works with skills on today's platform.** Git is in the mission image, each agent has a
private workdir, and agents' `Bash` has outbound network access, so cloning, branching,
committing, rebasing and running tests locally need only skills (branch and commit conventions,
testing before pushing, review checklists).

**What needs the platform.** Pushing, pull requests and reviews need a GitHub credential. With
skills alone the token would sit in the agent's environment or files, which breaks:
- custody: the agent, and anything injected into it, can read and exfiltrate the token;
- separation of duties: one token is one GitHub identity, so GitHub sees author and reviewer as
  the same account;
- governance: the token works whatever the work item's state; the platform never sees the push.

**Permissions in two layers.**
1. **GitHub's own model**, which holds even if MAGI is compromised:
   - one GitHub App per role (author, reviewer, release), with installation tokens that last an
     hour;
   - rulesets: no direct push to `main`, a review from the reviewer App, the existing gates as
     required checks, merges through GitHub's merge queue;
   - a protected release environment whose required reviewer is the user at first.

   It is coarse: per identity and per repository.
2. **MAGI's own model**, fine-grained and contextual:
   - roles in the mission policy, each a set of operations with conditions (a developer pushes
     `wi/<id>-*` branches only for items assigned to it and approved for build; a reviewer
     reviews only pull requests it did not author);
   - agents bound to roles; changing a binding is a policy change and goes through the gates;
   - the gateway (G) maps each role to its GitHub App, issues the token per call, and checks
     MAGI's rules first. Agents never see a token.

**How an agent pushes without a token.**
- A `PushBranch` tool, in which the daemon pushes from the agent's clone using the hardened git
  calls: simple, a first version.
- A **git proxy on loopback** run by the daemon, the target design. The agent's remote points at
  it, and the agent uses plain `git fetch` and `git push`. On a push the proxy reads which refs
  are being updated, checks each against the policy, and forwards to GitHub with the role's
  credential. This is the pattern of BrowseWeb's egress proxy.
- Ruled out: a credential helper that hands git a token, because the token then sits in a
  process the agent can read.

**Platform capabilities:**

| # | Capability | Part of |
|---|---|---|
| 1 | Roles and permissions in the mission policy: roles, bindings, operation grants with conditions; binding changes gated | E |
| 2 | GitHub connector: an App per role, hour-long tokens, an operation catalog (pull requests, reviews, comments, check results, release requests) | G |
| 3 | Git proxy with per-ref policy checks (`PushBranch` first) | G |
| 4 | Repository workspaces: a daemon-owned mirror, worktrees or shared-object clones per agent, shared package caches, disk quotas per agent | new |
| 5 | Egress policy for agent subprocesses: an allow-list per mission or role (the package registry; GitHub only through the proxy). Today `Bash` can reach anything; this also narrows prompt-injection exfiltration in every mission | new |
| 6 | GitHub configuration as code with a drift check: Apps, rulesets, CODEOWNERS, environments declared, applied, and checked on a schedule | new |
| 7 | GitHub events into MAGI (review requested, CI finished, merge-queue result) as mailbox wake-ups, through webhooks (a new authenticated endpoint) or polling | new |

Capabilities 1 to 3 are the general roles-over-connectors mechanism of E and G applied to one
connector; 5 benefits every mission.

**Commits** are authored as the agent, with trailers for the work item, the decision ids and the
mission; optionally signed by the platform so GitHub shows them as verified.

### The operator decides; agents configure

The user is not expected to set up or maintain any of this. A manager agent and the copilot
own the GitHub configuration, as they own the rest of the mission's setup:
- **The desired configuration is declared**: Apps and their permissions, rulesets, CODEOWNERS,
  environments, role bindings. It lives in the mission policy or in the repository.
- **Agents propose changes as diffs to that declaration.** A change goes through the governance
  engine like any other. A change that loosens a control governing agents (removing a required
  review, widening a role) falls under the platform invariant that the changer cannot approve
  it alone; under the default policy the user decides it in the decisions inbox.
- **The platform applies it**, through an administration role in the GitHub connector that no
  agent holds directly, and the scheduled drift check compares GitHub with the declaration and
  raises an anomaly on any difference.
- **Bootstrap.** GitHub requires the account owner to confirm creating and installing an App.
  The copilot prepares this with GitHub's App manifest flow, so the user's part is following a
  link and confirming on GitHub, once per App. Everything after that is done by agents.

The same principle applies across the platform: **the user sets direction and decides; agents
configure and operate.** A capability that needs the user to configure it by hand is incomplete.

## Topics still to refine

1. **The work item model.** The unit that ties intake, budget, gates, branch, pull request,
   release and review together. The objectives store's tasks are the starting point.
2. **Team design.** Roles, which agents are standing and which are started on demand, models,
   and the cost envelope.
3. **Coding capability.** Code navigation and editing tools for a large codebase, or a coding
   agent run as a tool inside the sandbox.
4. **Data migrations.** A migration framework and a gate for changes to stored data.
5. **Incident management.** Severity levels, on-call, communication, post-mortems; the emergency
   path through the gates.
6. **Porting today's practices.** CLAUDE.md, the practices documents and the Claude Code
   commands (sprint-audit, security-review, sprint-close and others) become MAGI skills and
   policy.
7. **Bootstrapping.** Deploying MAGI DEV's installation, its first policy, and importing the
   backlog from GitHub issues and the roadmap.

## Phasing

| Phase | Scope | Needs |
|---|---|---|
| 1 | Community, planning, monitoring reports | 28h items (#54, #95, G-5); B's per-mission repository; read-only use of A or, before A exists, reports from production's daily report |
| 2 | Application support | A (read and action tiers), E, F, G; auditor agent |
| 3 | Development and testing | B in full (through G), C, D; SDLC skills; evaluation harness |

## Open questions

- Which repository deploys production: `arnadu/magi_v3` itself, or a new repository while this one stays private? This decides when B must be complete.
- How MAGI DEV is sequenced against the feature wishlist (interactive apps #42, illustrations, document annotation). Interactive apps would also serve D's preview server.
- The initial governance policy: which actions start autonomous, which start approve-first, and what track record loosens them (see the governance engine's open questions).
