# MAGI DEV — requirements

Status: **draft, under discussion** (started 2026-11-07). Roadmap entry: the "Flagship track —
MAGI DEV" section of [MAGI_V3_ROADMAP.md](../../MAGI_V3_ROADMAP.md).

## Goal

A MAGI mission that runs the whole life-cycle of the MAGI platform: community, planning,
design, development, security, resilience and application support. The end state is an
autonomous mission; the user (the person or organization that owns the installation, called
the operator elsewhere in the repository) sets direction, budget and decision rights, and
approves what the policy says needs approval. It is also the flagship demonstration of MAGI for a software
audience.

Agent capability is not treated as the limiting factor. The work is in the controls (what each
agent may touch, for how long, who approves) and in the skills, team design and schedules that
make agents work well together. Quality is judged by results, as the user already judges
missions: tests first, CI as the gate, a reviewer that is not the author, approved releases.

## Assumptions

| # | Assumption | Consequence |
|---|---|---|
| A1 | **Mono-tenant.** One installation serves one organization (an enterprise or a family). It runs several teams and users, with no information-security boundary between them. | No per-tenant credential isolation (Sprint 29's CR-04 half), no cross-user privacy, no billing. The shared copilot OS identity (TB-15) becomes an accepted property. A multi-tenant SaaS later would reopen these. |
| A2 | MAGI DEV belongs to the same organization as the users' missions. | Support agents may read users' mission data. It still goes through an audited API, not raw database access: agents make mistakes, and mission content is untrusted text. |
| A3 | **Separate installations**, from phase 1. MAGI DEV runs on its own installation (its own Fly apps and database), not the production one. Phase 0 runs as an ordinary mission on the existing installation (see [Starting small](#starting-small-phase-0)). | MAGI DEV never holds a production deploy credential or database URI. A failure in either installation does not take down the other, and MAGI DEV can watch production from outside. |
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

The objectives below reduce to eight platform capabilities. Everything else is mission
configuration (team, skills, schedules) that can be iterated without platform changes.

| # | Deliverable | Content | Existing base |
|---|---|---|---|
| A | **Production Ops API** | A service identity for MAGI DEV, separate from `CONTROL_API_KEY`, with short-lived tokens. A read tier with no approval: mission status and health, anomalies, logs (through the control plane), stats and spend, resource samples, a mission's files and transcripts. An action tier, each action under the governance engine (E): suspend, resume, rollout, rollback, fork a volume, raise a cap. Every call recorded in production's audit log. Production's hard anomalies and daily report reach MAGI DEV through the read tier, polled by MAGI DEV's gateway; a push to an authenticated inbound endpoint is the alternative if polling proves too slow. The single production interface for human support staff too. New trust boundary. Design direction: [Production access](#production-access-deliverable-a). | Missions API and copilot actions; anomaly relay; daily report |
| B | **GitHub release control** | A repository per mission. A GitHub App per role (author, reviewer, release) used only through G; agents never hold a token. A git proxy on loopback (a `PushBranch` tool first) that checks each pushed branch against the policy. GitHub rulesets: no direct push to `main`, a review from the reviewer App, the existing gates as required checks, merges through the merge queue, and a protected release environment whose required reviewer is the user at first. GitHub configuration declared, changed by agents through E, applied by the platform and drift-checked. Design: [Source control for project code](#source-control-for-project-code-deliverable-b). | GitHub proxy (issues only, one repo, `GITHUB_REPO`); CI gates |
| C | **Staging installation** | A full MAGI stack (control plane, missions app, database) that CI deploys release candidates to. Runs the full integration suite, OS-isolation tests included, and an end-to-end smoke test: launch a test mission, check it runs, resume it, roll it out. | `promote.sh --suffix` named environments |
| D | **In-VM sandbox** | Repository workspaces: a daemon-owned mirror, worktrees or shared-object clones per agent, shared package caches, disk quotas per agent. Build, lint, unit tests and lightweight integration tests against a local `mongod`, never MAGI DEV's own database. LLM calls from tests go through a Tool API proxy that speaks the provider API, metered against a test budget; no raw key in the sandbox. A cockpit dev server previewed through BrowseWeb, which needs a sanctioned exception to the loopback block. A bigger default machine shape. | Tool API metering for jobs (`createJobSpend`); machine shapes (28g) |
| E | **Governance engine** | Gates (tollgates) with deterministic triggers at platform chokepoints, typed decision forms with platform-computed facts, deciders assigned by policy with separation of duties, binding single-use approvals, stage enforcement on work items, and a governance section in every agent's prompt and mental map. Not specific to MAGI DEV: any mission can declare gates (a household-finance mission approving payments). Design direction: [Governance engine](#governance-engine-deliverable-e). | Copilot confirmation cards (`ProposeAction`); objectives store write validation; daemon-managed mental-map regions (`#my-objectives`); the `beforeLlmCall` gate; spend ceilings an agent cannot raise |
| F | **Mission rollout and rollback** | A deploy only changes the image for new machines; running missions pick it up on suspend and resume. Production needs a rollout action: canary mission first, health check, then the rest, with automatic rollback. Triggered through A. | In-place resume (#103) |
| G | **External API gateway** | The one way agents reach any external API: connector definitions, platform-held credentials, per-operation policy, approval-bound single-use capabilities, rate limits and budgets, audit, responses treated as untrusted, inbound events. MAGI DEV reaches A and GitHub (B) through it; so would any mission reaching a bank, a mailbox or a data provider. Design direction: [External API access](#external-api-access-deliverable-g). | Tool API proxies for FRED, FMP and NewsAPI (CR-04); GitHub proxy; `safe-http.ts`; LLM metering for jobs |
| H | **Egress policy for agent subprocesses** | An allow-list per mission or role for outbound network access from agents' `Bash` and jobs (for example the package registry; GitHub only through the git proxy). Today they can reach anything. Narrows exfiltration after a prompt injection in every mission, not only MAGI DEV. | BrowseWeb's egress-filtering proxy |

Rule for MAGI DEV's own installation: it runs the previous stable release and is upgraded only
after production has run a release cleanly for some days. The user, helped by an external coding
assistant, is the emergency fallback if MAGI DEV breaks itself.

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

**The same mechanism serves human support staff and agents.** The Ops API is the single production
interface for both: people through the cockpit and CLI, MAGI DEV through G. The principles are
shared; the threats and the substitute for human judgement differ:

| | Human support staff | Agent |
|---|---|---|
| Who holds the credential | The person, on their own device, protected by MFA | The platform; the agent calls a proxied tool and never sees the token |
| Main threat | Phishing, a stolen laptop, mistakes under pressure | Prompt injection through what it reads (logs, users' mission data, community posts); mistakes at machine speed |
| Substitute for seniority | Role, seniority, on-call rota | The governance engine (E) and a track record |
| Unforeseen situations | Break-glass access, rarely used | Break-glass stays human, at least at first; the agent is limited to predefined actions |
| Volume | A few actions per incident | Possibly many: rate limits and per-action budgets |
| Accountability | The named person | The agent, its mission and the approver, recorded together |

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
a credential the agent must not hold, under rules the policy sets. The same need appears in
MAGI DEV (the production Ops API, GitHub, social channels, a status page), in research missions
(data providers, already proxied for FRED, FMP and NewsAPI after CR-04), and in personal
missions (a bank, a mailbox, a calendar). G is the one mechanism for all of them. It also
absorbs the post-MVP secret registry and the remaining CR-04 work, and replaces each proxy
being hand-built.

**Two sides.** A is a *server* MAGI builds in production. G is the *client* side in every
installation, used for A and for any third-party API. MAGI DEV calling production goes through
G on MAGI DEV's mission machine and arrives at A on the production installation.

**Two parts: the gateway on the mission machine, the broker on the control plane** (decided
2026-11-09). Missions stay self-contained, as in MAGI's original design, and root credentials
stay in one place:
- **The gateway** runs on each mission machine as its own process, under its own OS identity
  that neither the agents nor the daemon's sudo rule can reach. It does everything on the call
  path: connectors and the tools generated from them, the git proxy, the policy check (E), rate
  limits and budgets, audit, marking results untrusted. It is where the mission's egress policy
  (H) sends agents' traffic. It holds **short-lived credentials only**.
- **The credential broker** runs on the control plane and is the only reader of root
  credentials. It hands a mission's gateway a short-lived credential for an operation that
  mission's configuration allows, authenticating the gateway by the machine's own identity (Fly
  OIDC, to be confirmed) or a per-mission token like today's monitor token. It is off the call
  path: consulted only to issue or renew a credential.
- **Why not all central:** every external call would pass through the control plane, making it a
  dependency for all mission work; today running missions keep working while it is down or
  redeploying. **Why not all local:** root credentials would sit on every mission machine that
  needs them. The split is the common industry pattern: a local agent enforcing policy with
  temporary credentials from a central issuer (Vault Agent, SPIFFE/SPIRE, cloud instance
  credentials).
- **Static keys are the exception.** For a provider with no way to mint a short-lived
  credential, either the broker proxies that call centrally or the key sits in the gateway
  process: a per-connector choice recorded in the policy with its risk.
- **If the control plane is down,** calls continue until the gateway's current credentials
  expire (minutes to an hour). A fully compromised mission machine exposes its short-lived
  credentials for their remaining lifetime, never the keys that make them.
- **The control plane's role is therefore narrow:** the broker issues short-lived credentials,
  and the cockpit is where the user decides. Governance itself runs on the mission machine (see
  the governance engine's placement below).

**Few tools, data for the rest, skills for the know-how.** As a human engineer works with a few
general instruments (`curl`, a CLI), the provider's documentation and the team's runbooks, and is
limited by credentials and rules rather than by which buttons exist:

| Layer | What it is | How many |
|---|---|---|
| **Generic tools** (platform code) | One per kind of access: `ApiCall(connector, method, path, query, body)` for REST APIs; git through the git proxy; possibly a CLI route later | Two or three in total |
| **Connectors** (data) | Per provider: base URL, authentication, egress host, and an **operation catalogue** of method and path patterns, each marked read or action. Imported from the provider's OpenAPI description where one exists (GitHub, Fly's Machines API, the Atlas Admin API, OpenRouter) | One per provider |
| **Policy** (data) | Which agent may use which catalogue entries, on which targets, at which governance level, within which limits | Rows in the mission policy |
| **Skills** (know-how) | Which endpoints serve which task, worked examples, quirks, runbooks | As many as the work needs |
| **Credential adapters** in the broker (platform code) | How to mint a short-lived credential for each provider | About five |

Enforcement does not depend on the number of tools: the gateway matches every call against the
connector's catalogue and the policy, and refuses anything that matches no entry, so the generic
tool is not free-form where it matters. Request bodies are checked against the OpenAPI schemas.
Adding a provider means a connector, an adapter and skills; adding a task on an existing provider
is usually a skill, plus a policy line if it needs an operation not yet granted. Pseudo-code:
[Appendix: the gateway in pseudo-code](#appendix-the-gateway-in-pseudo-code).

**Real CLIs, where possible.** An agent can also use `flyctl`, the `atlas` CLI or `gh` as a human
would, with the CLI pointed at the gateway as its API endpoint and a placeholder token; the gateway
checks each request, swaps in the real credential and forwards it, as the git proxy does. This
needs each CLI to accept another API address over plain HTTP on the machine (otherwise the gateway
would have to intercept encrypted traffic), so it is checked per tool; `ApiCall` is the universal
route. A provider's MCP server can sit behind the gateway in the same way.

**A connector** is declared in configuration, never opened by an agent at run time:
- the endpoint and the egress rules (`safe-http.ts` pinning; no redirects outside the host);
- **the operation catalogue**: method and path patterns, each marked read or action, with body
  schemas where available;
- **the credential**: which broker adapter mints it, and which path parameter it is narrowed to;
  the adapter handles the provider's credential type:
  - a static API key;
  - OAuth 2.0 with the user's consent (mail, calendar, a bank);
  - workload identity (OIDC);
  - a token minted per session.

Which agents may use which operations is in the mission policy, not in the connector.

**The gateway does, for every call:**
1. **Custody.** It holds a short-lived credential from the broker, renews it, and attaches it to
   the request. Agents and their subprocesses never see it.
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

**Each provider has its own privilege model**, and a connector uses the narrowest, shortest-lived
credential the provider supports. To be confirmed per provider; what each is understood to offer:

| Provider | Scoped or short-lived credentials | Typical MAGI DEV uses |
|---|---|---|
| GitHub | An App per role; installation tokens last an hour; fine-grained repository permissions | Branches, pull requests, reviews, releases, issues |
| MongoDB Atlas | Service accounts with OAuth tokens; project roles (read-only through owner); temporary database users with an expiry date; access lists per key | Backups and restores, usage and alerts, temporary read access for diagnosis, staging databases |
| Fly.io | Tokens scoped to an app or an organization, with an expiry; deploy-only and read-only kinds | Staging installations, logs, capacity and quota checks; production changes go through A |
| OpenRouter | A provisioning key that creates and manages API keys, each with its own credit limit | Keys with a budget per environment or test run; credit monitoring |
| Firebase / Google Cloud | Service accounts with IAM roles; short-lived tokens by impersonation | User administration for the cockpit; staging projects |

**Two routes into production.** Operations on the product (a mission's status, a resume, a
rollout) go through the production Ops API (A), whose control plane already holds the provider
credentials. A connector straight to a provider (G) is for what the product does not expose:
infrastructure administration, backups and restores, quotas, costs, and building staging
environments. The first route is preferred whenever both exist.

**Inbound events.** Connectors can also receive: GitHub webhooks, Atlas alerts, Fly machine
events. G verifies each event's signature and delivers it to the mission as a mailbox wake-up.

### Secrets management

**How organizations do it with human staff.** Three generations, all still seen:
1. **Credentials handed to people**, kept in `~/.aws/credentials`, `.env` files or a shared
   password vault. The source of most credential leaks: keys committed to git, stolen laptops,
   keys that outlive a departure, no record of who used what.
2. **A secrets manager with injection.** Secrets live in a central store (HashiCorp Vault, AWS
   Secrets Manager, Google Secret Manager, Azure Key Vault, Doppler, Infisical, 1Password) that
   encrypts them, controls who reads each one, logs every read, keeps versions and rotates them.
   A wrapper injects a secret into one command for its lifetime (`doppler run`, `op run`,
   `vault exec`, `aws-vault exec`): never on disk, but visible to the command and to whoever can
   inspect it.
3. **Identity first, secrets as the exception** (current best practice):
   - people hold no long-lived keys; they sign in once (single sign-on with MFA) and tools
     obtain short-lived credentials from that identity (`aws sso login`, `gcloud auth login`,
     `gh auth login`, the Atlas CLI's login); elevated access is requested and expires;
   - **dynamic secrets**: the manager creates a credential on demand and destroys it afterwards
     (Vault's database engine creates a temporary database user per request);
   - **access proxies** (Teleport, StrongDM, Boundary) inject the credential into the connection,
     so the person never sees it;
   - the remaining long-lived secrets are the keys that make keys (a provider's admin or
     provisioning key) and break-glass credentials: kept in the manager, rotated, read only by
     the systems that mint short-lived credentials.

Two problems every design answers: **secret zero** (what lets a process read the secrets manager;
the modern answer is workload identity, a signed token proving which machine is calling) and the
**lifecycle** (an inventory of every secret, rotation, and revocation as the first step of any
incident).

**Transposed to agents: stricter than generation 2.** Agents never receive a secret, not even
injected into a command they control: an agent can inspect its own processes, and an injected
instruction can ask it to print its environment.

| Layer | Human practice | MAGI |
|---|---|---|
| Root credentials (Atlas admin, Fly organization, OpenRouter provisioning, GitHub App private keys, a Google service account) | In the secrets manager, read only by the minting systems | In a secrets store read only by the credential broker on the control plane. Never on a mission machine |
| Per-use credentials | Dynamic, short-lived | Minted per call or session where the provider allows: GitHub App tokens (1 h), Atlas service-account tokens and temporary database users, Fly tokens with an expiry, OpenRouter keys created with a credit limit for one task and deleted afterwards, Google tokens by impersonation |
| Delivery | Proxy injection, or injection into one command | **Proxy injection by default**: G's connectors for API calls, the git proxy for git. **Catalogue commands** where a CLI is unavoidable (`flyctl`, `atlas`, `firebase`): the platform runs a predefined command under its own OS identity with the credential injected, and returns the output marked untrusted; the agent chooses the command and its parameters, never the environment |
| Secret zero | Workload identity | The control plane proves its identity to the store by workload identity, if Fly's machine OIDC tokens work with the chosen store (to be confirmed); otherwise one bootstrap secret, as today's Fly secrets |
| People | Single sign-on and short-lived logins; break-glass in a password manager | The user and any human staff use their own provider logins, never a shared key. The break-glass `CONTROL_API_KEY` sits in a password manager, not a file |
| Lifecycle | Inventory, rotation, revocation | A secrets inventory kept by the platform; rotation and revocation are governed operations run by an operations agent through E; the appsec agent reviews the inventory |

**Egress policy (H) complements, not replaces, this.** A leaked key works from anywhere, so the
first defence is that agents never hold one. H narrows what an injected instruction can send out
and forces traffic through the gateway and git proxy, where policy and audit apply.

**Where MAGI stands.** The data-provider keys (FRED, FMP, NewsAPI) already follow proxy
injection: background jobs call the Tool API, which adds the key (CR-04). The gap: every mission
daemon receives the cluster-wide `MONGODB_URI` and LLM keys in its environment, and the control
plane's root credentials are Fly secrets in environment variables. Under the mono-tenant
assumption this is no longer a cross-tenant problem, but it is the blast radius if an agent
escapes to the daemon.

**Direction:**
1. **Start with Fly secrets; move to a managed store when needed, never build one.** Today the
   control plane's keys are Fly secrets: encrypted by Fly and injected only into the control
   plane machine. The broker starts by reading its root keys the same way, so no new service is
   needed at first. A managed store (Google Secret Manager, in the Google Cloud project Firebase
   already gives MAGI; or Infisical, open source and self-hostable) adds rotation, versions and a
   log of every read, when those become needed. Building a store is not on the table:
   encryption, access policy, audit, versions and rotation are what a managed store already
   does.
2. **The broker runs in the control plane** (or a small service beside it), so root credentials
   never reach mission machines; each mission's gateway asks it for short-lived credentials and
   makes the calls itself (see "Two parts" above).
3. **Dynamic credentials per provider**, as far as each allows; a provider with only static keys
   keeps its key in the store, used only by the proxy.

With a managed store, Sprint 29b's at-rest encryption is no longer needed for credentials; it
reduces to encrypting mission data.

## Governance engine (deliverable E)

### What human organizations already do

| Human organization | What it does | Transposed to MAGI |
|---|---|---|
| Policy manual | States which decisions need whose sign-off | A versioned policy file: gate definitions, triggers, forms, decider assignments, thresholds |
| Delegation-of-authority matrix | Who may decide what, by amount or kind | Decider assignment rules per gate, with escalation levels |
| Decision forms | Establish the facts that place a decision in the matrix, and present them in a format the decider knows | Typed forms per gate; facts computed by the platform, judgement supplied by the requester |
| Stage-gate (tollgate) process | Work cannot pass a stage without sign-off | Work items with stages; the transition through a gate needs a decision record |
| Change management (ITIL) | **Standard** changes pre-approved; **normal** changes reviewed by a change advisory board; **emergency** changes expedited, then reviewed | Autonomous (a pre-approved catalogue), approve-first (an agent committee or the user), emergency path with mandatory review afterwards |
| Change advisory board | A committee reviews significant changes | An agent committee with different roles, with or without the user |
| Segregation of duties | Whoever requests or performs cannot approve | Requester and decider are different agent identities, enforced |
| Delegation letter | Authority granted for a scope, an amount and a period | An authorization bound to a work item: paths, budget, expiry |
| Signature or stamp | Proof of approval | A decision record plus a single-use capability bound to the exact artefact version or parameters |
| Job description, training, code of conduct | People know the rules before they act | The governance section of each agent's system prompt and mental map |
| Internal audit | Checks after the fact that the rules were followed | The auditor agent, plus the user sampling agent-approved decisions |

### Where it runs

Governance runs where the action happens, not on the control plane:
- **The policy check** runs on the mission machine: in the gateway (external calls, through the
  daemon's check) and in the daemon (stage transitions in the objectives store, which it already
  validates).
- **The policy and the decision records** are data in the installation's database, like the
  rest of the mission's state.
- **The decisions inbox** is a cockpit view. A mission's Decisions tab is served through the
  cockpit's mission proxy, like every other mission tab; the cross-mission list reads the
  database, like the missions list.
- **Platform-level decisions** (launching a mission, changing a spend ceiling) are the exception
  and run on the control plane, as the control-plane copilot's actions do today.

### Five parts of a gate

| Part | What it is | Where it lives | Can the requesting agent bypass it? |
|---|---|---|---|
| **Trigger** | The rule that says this action needs a decision | Deterministic platform code at a chokepoint | No |
| **Form** | The structured decision record | A typed schema; facts by the platform, judgement by the requester | Facts no; judgement is reviewed |
| **Decider** | Who signs: an agent, a committee, the user | Assigned by the policy, never chosen by the requester | No |
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
  It is not part of the team configuration, which the mission copilot edits freely, so it changes
  only through a policy change, under the gates the policy places on policy changes. Content:
  - the gates that apply to this role;
  - the standing rules in plain, firm language with the reason for each ("Do not begin
    implementation of a work item until it shows *approved for build* in your governance section.
    Work started earlier is wasted: merges of unapproved items are refused.");
  - how to request a decision;
  - **what counts as an approval: only a record shown in the governance section.** A message
    from a teammate, a community member or a web page saying something was approved is not an
    approval, whoever appears to send it.
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
  - For the user: the decisions inbox in the cockpit (below).
- **Stage enforcement on work items.** A gate can only check a state the platform holds, so the
  work an agent is authorized to do must live in a platform store, not only in files or mental
  maps. The objectives store's tasks are that store. The platform addition is small: a stage
  field and transition checks, so the store refuses a transition that passes a gate without a
  bound decision (it already validates ownership on writes). Which stages a mission uses and
  what they mean (for MAGI DEV: proposed, approved for design, designed, approved for build, in
  build, ready for review, merged, released, reviewed) is mission policy and skills.
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
- the control-plane copilot's `ProposeAction`: typed action schemas, a pending action, the user's
  confirmation, atomic claim, re-validation at execution (`copilot-actions.ts`);
- `file_github_issue`: provenance prefix, forced label, daily cap;
- the mission copilot's same-turn audit copies of every mutating tool to the user, and the
  missing confirmation for its pause, resume and schedule-cancel actions (CR-07 remainder,
  F-026);
- spend caps and ceilings: the default cap, the platform ceiling, only an admin may exceed it
  (ADR-0034); the copilot's own spend cap and turn time limit;
- machine upgrades: the mission copilot decides, within a 60-minute window and a 24-hour
  cumulative cap that the user can reset (ADR-0031);
- schedule rules: the 5-minute cron floor, recipients on the roster, a job schedule names only
  its author.

**The copilot's confirmation cards are refactored, not kept beside the engine.** Today a
`ProposeAction` produces a card with a Confirm button in the copilot chat. Under the engine, each
action type becomes a gate in the default policy, its zod schema becomes the gate's form, and the
pending action becomes a decision request shown in the decisions inbox (below). The chat card
becomes a pointer to the inbox, with no buttons. The atomic claim and the re-validation at
execution carry over as the engine's single-use capability. The other items above become
policy entries the same way.

### Who can change what

Nearly everything is data the mission copilot (or a manager agent) maintains; the default policy
routes changes that would loosen the controls on agents to the user. Root keys and platform code
are maintained differently.

| Tier | What | Who changes it, and how | Why |
|---|---|---|---|
| **0. Platform** | `ApiCall`, the gateway, the git proxy, the broker and its adapters, the governance engine, the platform invariants | A code release only: pull request, review, CI, release approval. In phase 3 MAGI DEV's developers can write the change; changes to these files need the appsec agent's review and the user's approval | They are the controls; MAGI DEV runs the previous stable release, so a change applies only after production has run it cleanly |
| **1. Root keys** | Fly organization token, GitHub App keys, Atlas service account, OpenRouter provisioning key, Ops API client credential | The user, with the copilot preparing it (Fly secrets, GitHub App confirmation pages). Later, rotation can be a governed operation the broker runs after the user's approval | No agent ever sees a root key, so none can set one |
| **2. Loosening changes** | Connector endpoints and credential binding; granting an agent a new operation or a wider target; lowering an approval level; widening the egress policy; binding an agent to a role; the rules for policy changes | The copilot proposes; under the default policy the user decides in the decisions inbox | A copilot able to widen rights alone would be the weak link (platform invariant 3) |
| **3. Everyday changes** | Adding a catalogue entry (grants nothing by itself); narrowing a grant; skills; schedules; prompts and mental-map templates; objectives and tasks | The copilot itself, recorded, with a notice to the user for some | None can widen anyone's access: enforcement is in the gateway and the policy, not in what an agent knows |

Every change is versioned in the mission's config revisions: who, which decision, and a way back.

**Details that keep this safe:**
- **A credential is bound to its provider's hosts.** Each broker adapter declares its provider's
  hosts, and the gateway attaches a credential only to requests to those hosts. This is platform
  code (tier 0), so changing a connector's base URL cannot send a minted token elsewhere.
- **Granting rights to another agent counts as loosening.** Otherwise the copilot could grant an
  agent an operation and then direct it, widening its own reach indirectly.
- **Skills are knowledge, not permission.** A call succeeds only if a grant exists, so skills sit
  in tier 3. Agent-written skills stay labelled and cannot shadow platform or team skills
  (F-047).

**The tiers are the default policy template**, mission policy rather than platform code, except
tier 0 and the invariants. As the copilot builds a track record, the user can move items down,
for example letting it add grants on staging apps itself while production-facing grants stay with
the user. Today's copilot tools (`SaveMissionConfig`, applied at the next resume; the immediate
tools of F-026) become tier 2 or tier 3 entries when the engine is built.

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
| G0 Intake accepted, budget allocated | Work item created with a budget (objectives store) | Planning agent within a budget envelope; the user above it |
| G1 Design approval | Move to *approved for build*; an ADR or threat-model update is required when the change touches defined areas | Architect agent plus a security reviewer; the user for a new trust boundary |
| G2 Ready to merge | Merge through the GitHub proxy | A reviewer agent that is not the author, plus green CI |
| G3 Release readiness | Release requested | Release-manager agent plus staging results; the user at first |
| G4 Production rollout | Rollout action on the Ops API | Canary health; the user at first |
| G5 Post-implementation review | Release plus N days | Planning agent; reported to the user |
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

## Source control for project code (deliverable B)

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
| 4 | Repository workspaces: a daemon-owned mirror, worktrees or shared-object clones per agent, shared package caches, disk quotas per agent | D |
| 5 | Egress policy for agent subprocesses: an allow-list per mission or role (the package registry; GitHub only through the proxy). Today `Bash` can reach anything | H |
| 6 | GitHub configuration as code with a drift check: Apps, rulesets, CODEOWNERS, environments declared, applied, and checked on a schedule | B |
| 7 | GitHub events into MAGI (review requested, CI finished, merge-queue result) as mailbox wake-ups, through webhooks (a new authenticated endpoint) or polling | G |

Capabilities 1 to 3 are the general roles-over-connectors mechanism of E and G applied to one
connector; 5 (H) benefits every mission.

**Commits** are authored as the agent, with trailers for the work item, the decision ids and the
mission; optionally signed by the platform so GitHub shows them as verified.

### The user decides; agents configure

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
- **Roadmap and plan** artefacts with a cadence: weekly planning, monthly review, the user's sign-off on the roadmap [partial].
- **Feedback loop.** Release, measure usage, revise priorities; depends on product analytics (8) [new].

### 3. Design

- **Artefacts:** ADRs, spec, threat model, FMEA, code-structure inventory [exists as practices and skills].
- **UX mockups and clickable prototypes.** Needs image generation, the HTML preview in Files, and the sandbox preview (D) [new].
- **Design review** by a reviewer agent that is not the author, plus the user's sign-off above a threshold (E) [partial].

### 4. Development, source control, testing, release

- **Source control.** Branch per change, pull requests, protected `main`, per-role credentials (B) [new].
- **Supply chain.** Lockfile, audit, pinned versions [partial].
- **Test tiers.** Sandbox (D), staging (C) [new]. Evaluation harness for agent behaviour (#45) [new].
- **Pipeline.** The existing gates (verify, tripwires, ratchets, SAST, secret scan, dependency audit) [exists], made required checks on pull requests (B) [new].
- **Code review** by an agent that did not write the change [new skill]. Author-reviewing-self was a root cause in the October 2026 audit.
- **Release.** Staging, then beta, then production. Versioning, changelog, rollout and rollback (F) [partial].
- **Merge policy.** The user merges at first; policy-based auto-merge for low-risk changes later (E) [new].

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

- **Observability** through A: logs, LLM call traces [exists], metrics [partial], alert routing to MAGI DEV and the user [new].
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

- **Decision rights** (E) [partial].
- **Weekly report to the user:** decisions taken, spend against budget, open escalations [new skill].
- **KPIs for the mission:** throughput, cost per deliverable, escaped defects, response times [new].
- **Pause** [exists]. Rollback of anything done autonomously [partial].

## Topics still to refine

**Settled without new platform capability** (2026-11-08):
- **Coding agents are ordinary agents** with their own skills and focus, not a coding tool run
  inside a sandbox.
- **The work item model** reduces to the stage field and transition checks in the governance
  engine (above); the rest is policy and skills.
- **Data migrations** are a feature of the product MAGI DEV develops (a versioned migration
  runner with a backup first, shipped in releases), not a capability MAGI DEV needs in order to
  operate. A migration ships through the release gates; a restore goes through the Atlas
  connector.
- **Incident management** is process and skills on top of A, G, the governance engine's
  emergency path, and out-of-band alerting (G-5).
- **Capacity.** A mission stays on one machine. MAGI DEV uses a bigger machine shape; worker
  machines or spreading a mission over several machines are considered only when cost or a real
  limit forces it.

- **Bootstrapping** is incremental: see [Starting small](#starting-small-phase-0).

**Still open:**
1. **Porting today's practices.** CLAUDE.md, the practices documents and the Claude Code
   commands (sprint-audit, security-review, sprint-close and others) become MAGI skills and
   policy.
## Starting small (phase 0)

MAGI DEV starts with the smallest scope and the fewest agents that can achieve it, and grows from
there. The first implementation is **just another mission on the existing installation**: the
dev environment that runs the user's other missions. Nothing about the separate-installation
design is needed while the mission is read-only.

**Why this works on today's platform.** The repository is public, so an agent clones it with
plain `git` in its own folder: no credential and no new platform capability. The separate
installation (A3), the production Ops API (A) and push rights (B) matter only once the mission
needs production access or writes to the repository.

**The first scope: an infosec specialist.** Two agents: the mission copilot (always present) and
the specialist.
- **Why first.** The October 2026 audit found the same author writing and reviewing to be a root
  cause; an independent reviewer of each change is useful from day one. The procedures already
  exist as Claude Code commands (`security-review`, `security-audit`, `threat-model` in
  `.claude/commands/`) and port to MAGI skills, with the threat model and findings tracker as
  the agent's reference. The work is read-only.
- **Remit:**
  - after each push: review the new commits against the threat model;
  - weekly: new dependency advisories, consistency of the threat model and findings tracker with
    the code, and one trust boundary in depth;
  - on request: a security review of a design, such as the Ops API or the gateway.
- **Findings stay private.** The repository is public, so a vulnerability filed as a public issue
  would disclose it before it is fixed. Findings go to reports in the mission's files and to the
  user through the mission mailbox; later, as private GitHub security advisories through the
  GitHub connector (G).
- **Cost.** Diffs on each push plus one budgeted deep dive a week; the mission's spend cap
  bounds it.
- **Limits.** Dependabot alerts need a GitHub credential even on a public repository, so they
  wait for G. CI results are readable without one, at a low rate limit, and `npm audit` runs in
  the agent's own clone.

**The second agent: a code reviewer.** The same inputs (the repository clone, review skills) with a
correctness lens, in the manner of `/code-review`. Together the two cover the reviewing side of
the life-cycle before any agent writes code.

**Other candidates**, for later: a planning and roadmap steward (works today, with issue edits
through the existing confirmation cards); an ops monitor (needs A's read tier); community and
triage (needs channel connectors, apart from reading GitHub issues).

**Setting it up.** Nothing on the roadmap blocks phase 0; the time to start is the setup itself,
about one to two days:

| Step | Effort | Notes |
|---|---|---|
| Port `security-review`, `security-audit` and `threat-model` from `.claude/commands/` to MAGI skills | Half a day to a day | Reworded for a MAGI agent: its tools, its own clone, findings kept private, the report format below |
| Team template `config/teams/magi-dev.yaml`: the copilot and the infosec specialist, prompts, schedules | A few hours | |
| Launch from the cockpit, with a spend cap above the $25 default | Minutes | |
| A first supervised run: clone, first diff review, first weekly sweep | Half a day of watching | Where the unknowns show up |

Practical points, none of them roadmap work:
- **"After each push" becomes "on a schedule".** Without GitHub webhooks (G) a push cannot wake
  the mission. A scheduled turn every few hours, or daily, reviews the commits since the last
  reviewed one; the agent records that commit in its files.
- **Cloning from `Bash`** should work, since agents' subprocesses have no egress filter today
  (H does not exist yet). Not yet confirmed on a live mission; the first run shows it.
- **No `npm install`.** `npm audit` reads `package-lock.json`, so the clone stays small.
- **The 28h items are not prerequisites.** Supervisor cycles (#95) cannot arise with two agents,
  the soft-anomaly digest already prevents notice floods, and conversation growth (#54) matters
  only after weeks of running.

**Feedback to the development environment.** In phase 0 the user's development environment is
a Claude Code session on the user's machine, with the repository. Findings reach it without any
new platform capability:
- **Reports are the hand-off.** Each review writes one Markdown report to the mission's files,
  `shared/reports/security/YYYY-MM-DD-<kind>.md`, with:
  - the commit range or the area reviewed;
  - one entry per finding: the mission's own id (`MD-NNN`), severity, `file:line`, the evidence,
    the suggested fix, and the entry formatted as a row of `docs/security/findings.md`, so it can
    be pasted in as is;
  - a closing **hand-off block**: a short, self-contained instruction for a coding assistant
    ("Fix MD-012 and MD-014; for each, a test that fails before the fix") that the user copies
    into Claude Code.

  The mission keeps its own register (`shared/reports/security/register.md`) of every finding
  and its status. Official `F-NNN` numbers are given in the repository when a finding is
  accepted, so the two numbering schemes never collide.
- **Getting a report into Claude Code**, simplest first:
  1. **Copy and paste** the hand-off block from the Files panel.
  2. **Download** the report from the Files panel and point Claude Code at the file.
  3. **Claude Code fetches it**, through the control plane's mission-files route, when the user
     asks ("read the latest MAGI DEV security report"). This needs a credential on the user's
     machine: today `CONTROL_API_KEY`, which the Ops API design reduces to break-glass, so this
     option is a convenience for phase 0, not the long-term path.
- **Closing the loop.** The next scheduled review sees the fix in the new commits and marks the
  finding *fixed, verified* in the register. The user can also tell the agent directly, by a
  message from the cockpit ("MD-012 fixed in abc1234"), and it verifies at its next turn.
- **Not through public issues.** The repository is public, so a security finding filed as an
  issue would disclose it before it is fixed. Later, G's GitHub connector files findings as
  private security advisories.
- **Optional mail.** For high-severity findings, the agent also mails the user, so they appear
  without opening the Files panel.

### The application security architect

The phase 0 agent, designed for the team it will join: in the target organization it belongs to
the CISO's team and takes part in the software life-cycle at several gates.

**Mandate.** Make the platform secure by design: the security of the architecture, the code and
the tooling, including the design of monitoring and audit tools, but not their operation.

| In scope | Out of scope |
|---|---|
| Threat modelling, trust boundaries, security requirements for new designs | Watching for indicators of compromise; operating a SOC or SIEM |
| Reviewing code and dependency changes for vulnerabilities | Responding to live incidents; triaging security alerts |
| The findings register and the security documents (threat model, trust boundaries, findings tracker, security practices) | Production access or production actions |
| **Designing** monitoring and audit: what to log, the audit log's structure, detection requirements, alert rules as specifications, the auditor agent's checks | Running those tools or acting on what they detect |
| Security sign-off at the life-cycle gates (design, budget, release) | Writing product code: it proposes fixes, others implement them |
| Lessons from incident post-mortems, as input to design | Leading an incident |

Two roles stay separate from it: a future **security operations** role, which operates what this
role designs; and the governance engine's **auditor agent**, which checks that the mission
follows its own rules. Keeping them apart avoids an agent judging its own designs.

**Built for the future team now:**
1. **A stable identity**: agent id `appsec`, name "Application Security Architect". The
   governance policy will bind this id to the security-reviewer decider role, and it appears in
   decision records, the findings register and commit trailers.
2. **One review skill, two kinds of trigger.** Review a diff, review a design, review a release,
   estimate a work item's security cost. A schedule or a message starts them in phase 0; a
   governance decision request starts the same skill later.
3. **Outputs shaped like the future gate forms.** Fixed verdicts: *no security impact*,
   *approve*, *approve with conditions* (a structured list of must-fix-before-release findings),
   *reject* (citing the blocking findings). Severity as in `docs/security/findings.md`
   (critical, high, medium, low). One blocking rule from the start: no open high or critical
   finding in scope at release.
4. **Separation of duties from day one.** It never writes product code; fixes go to Claude Code
   through the hand-off block, later to developer agents. Its changes to the security documents
   are proposals someone else accepts: the user now, the architect agent later.
5. **A request contract**: a team skill, "how to ask for a security review", with the request
   types design review, release review, budget estimate and question. Used by the user and the
   copilot in phase 0, by every teammate later.
6. **A mental map structured for team life**: standing responsibilities, the review cursor (the
   last commit reviewed), a findings summary, open questions to the user, and "who sends me
   what", empty until the team grows.

**Its place in the life-cycle:**

| Gate | Its contribution | In phase 0 |
|---|---|---|
| G0 Intake and budget | Security effort per work item (threat-model update, security tests, review time); flags items whose risk exceeds their budget; argues for a recurring security budget | A security backlog with a cost estimate per item |
| G1 Design approval | Security reviewer on the committee: threat-model delta, new trust boundaries, security requirements | Design reviews on request |
| G2 Ready to merge | Required reviewer only for security-sensitive changes (auth, sudo, paths, egress, the gateway), selected by file patterns in the policy | A scheduled review of every new commit |
| G3 Release readiness | Sign-off: no open high or critical finding in scope, dependency audit clean, security documents current | A release-style sweep on request |
| G5 Post-implementation review | Did the design hold: incidents and findings checked against earlier verdicts | The register records verdicts and outcomes |

#### Objectives

In the objectives store's format: each objective has an id, an owner, a budget and KPIs; a KPI
is agent-reported, rolled up from tasks, computed from turn statistics, or set by the user. In
phase 0 `appsec` owns every objective. In the target organization the top objective moves to the
CISO (an agent or the user) and `appsec` keeps the children. Budgets are placeholders for the
user to set at launch.

| Id | Objective | KPIs (source, target) |
|---|---|---|
| **SEC** | **MAGI is secure by design** (top) | Open critical and high findings (agent-reported, 0); the mission's own spend against budget (computed from turn statistics) |
| SEC-1 | **Change assurance:** every change to `main` is security-reviewed promptly | Days since the oldest unreviewed commit (agent-reported, ≤ 1); share of commits reviewed (agent-reported, 100%) |
| SEC-2 | **Findings management:** the register is current, every finding actionable and tracked to a verified fix | Median age of open high findings in days (agent-reported, ≤ 14); share of closed findings with a verified fix (agent-reported, 100%) |
| SEC-3 | **Security knowledge base:** threat model, trust boundaries, findings tracker and practices match the code | Trust boundaries reviewed in depth in the last 26 weeks (agent-reported, all 22); accuracy of the documents (set by the user, qualitative: "would a new engineer be misled?") |
| SEC-4 | **Supply chain:** no known high or critical advisory in production dependencies | Days from a published advisory to its report (agent-reported, ≤ 2); open high or critical advisories (agent-reported, 0) |
| SEC-5 | **Secure design:** planned work gets security requirements before it is built | Design reviews delivered within two days of the request (agent-reported, 100%); usefulness of the reviews (set by the user, qualitative) |
| SEC-6 | **Monitoring and audit design** (design only): audit, logging and detection specifications for the platform | A specification for each new capability before its build starts: A, E, G, H first (rolled up from tasks) |
| SEC-7 | **Security planning and budget:** a costed security backlog and a recurring security budget | Backlog items with an estimate (agent-reported, 100%); a quarterly budget proposal delivered (rolled up from tasks) |

#### Initial tasks

One-off tasks for the first weeks, assigned to `appsec`:

| Id | Objective | Task |
|---|---|---|
| T-01 | SEC | **Onboard.** Clone the repository; read `docs/security/` (threat model, trust boundaries, findings, `CLAUDE.md`), the practices documents and the ADRs; build the mental map; set the review cursor. |
| T-02 | SEC-2 | **Baseline register.** Import the open findings of `docs/security/findings.md` (F-022, F-026, F-029, F-031 and the rest) and the open `security`-labelled issues into the mission's register, with status and a suggested next step. |
| T-03 | SEC-1 | **First change review: `46ca265..HEAD`** (27 commits since the whole-repo audit, not yet security-reviewed), then move the cursor to `HEAD`. |
| T-04 | SEC-4 | **Supply-chain baseline.** `npm audit` for production and development dependencies; report and register entries. |
| T-05 | SEC-5 | **Design review of this requirements document**: production access (A), the gateway (G), the governance engine (E), egress policy (H), source control (B). Verdict and security requirements per deliverable. |
| T-06 | SEC-3 | **First drift sweep:** compare the "open" rows of `docs/security/trust-boundaries.md` with the code. |
| T-07 | SEC-6 | **Audit and detection requirements** for A, E and G: what each must log, the audit record's fields, which events should raise an alert. |
| T-08 | SEC-7 | **Costed security backlog** from the register and the roadmap's security items (#66, #67, #75, #78 and others). |
| T-09 | SEC | **First weekly summary** to the user: what was reviewed, findings by severity, KPI values, what needs a decision. |

#### Recurring duties

Tasks in the store do not repeat, so the recurring work is driven by schedules; each run updates
the KPIs it affects.

| Cadence | Duty | Objective |
|---|---|---|
| Every 6 hours | Review the commits since the cursor; report; move the cursor | SEC-1 |
| Weekly | Dependency advisories; drift check of the security documents; one trust boundary in depth; the weekly summary to the user | SEC-3, SEC-4, SEC |
| Monthly | Register review and KPI update; security backlog and estimates refreshed | SEC-2, SEC-7 |
| Quarterly | Security budget proposal | SEC-7 |
| On request | Design review, release sweep, budget estimate, question (the request contract) | SEC-5, G1–G3 |

#### Skills

The existing Claude Code commands (`security-review`, `security-audit`, `threat-model`,
`sprint-audit`) are raw material, but they are jobs run on request. The skills below follow how a
human application security engineer organizes the work over time.

**How the work is organized.** Everything uses or refreshes two things: a **model of the system**
(architecture, assets, trust boundaries, the house security rules; written down as the threat
model) and a **risk register**. Four modes:

| Mode | What it looks like | Trigger |
|---|---|---|
| Incremental | Triage each change by its security relevance and go only as deep as that warrants; check against the model and the house rules; note when the model has gone stale | Every change, every new advisory |
| Deep | Refresh the model: a boundary in depth, a design, one vulnerability class across the code, the supply chain end to end | A schedule, a design request, or an incremental review that found the model stale |
| Engagements | Design review, release sign-off, estimates, questions | Requests |
| Record and communicate | Register, reports, weekly summary, immediate escalation, KPIs | Every activity |

Three habits matter as much as the procedures:
- **Depth matched to risk.** Without a triage step, either cost explodes or the risky change
  gets the same glance as the rest.
- **Variant analysis.** A confirmed finding triggers a search for the same pattern everywhere
  (F-073, the Research cache symlink, was a variant of F-038).
- **Refute before reporting.** As the sprint audit's independent verifier does: false positives
  cost credibility with the team.

**Foundations** (used by every other skill):

| Skill | Content | Built from |
|---|---|---|
| `appsec-foundations` | Where the security documents are and how they fit; MAGI's house security patterns and invariants (`safe-path`, `safe-http`, the sudo boundary, clean environments, scoped queries, untrusted-content wrapping); the mono-tenant assumption; the scope, including what is out of scope | `docs/security/CLAUDE.md`, the security practices |
| `security-judgement` | Severity in MAGI's context (the `findings.md` scale); the standard of evidence (a concrete exploit path, or labelled as a hypothesis); refuting oneself before reporting; the four verdicts | The sprint audit's verifier step |
| `findings-register` | Format, `MD-NNN` ids, lifecycle (new, confirmed, reported, accepted as `F-NNN`, fix proposed, verified fixed; or accepted risk, false positive, duplicate), de-duplication, fix verification | `findings.md` conventions |
| `security-reporting` | Report template and hand-off block; weekly summary; immediate mail for high and critical; never a public issue | New |

**Incremental:**

| Skill | Procedure | Built from |
|---|---|---|
| `change-review` | Commits since the cursor; triage each by file patterns and signals (auth, sudo, process spawn, paths, network, queries on external input, environment variables, new endpoints, new dependencies) into skip, skim or deep; check against the house patterns; flag a threat-model delta when a boundary is created or changed; findings through `security-judgement`; variant search for each confirmed finding; report; move the cursor | `security-review` |
| `advisory-triage` | New advisories since the last baseline: production dependency or not, vulnerable code reached or not, exploitability in MAGI's use; recommend upgrade, override or accepted risk; register | New |

**Deep** (one-off or periodic refresh):

| Skill | Procedure | Built from |
|---|---|---|
| `threat-model-refresh` | The whole model, or one boundary in depth: read its implementing files, check each listed mitigation holds, try to break it, propose updated rows (actors, data flows, boundaries, STRIDE, OWASP LLM Top 10) | `threat-model`, `security-audit` |
| `vulnerability-hunt` | One class across the codebase ("every subprocess spawn", "every query on external input", "every path from input"), with variants and verification | The sprint audit's specialist auditors |
| `supply-chain-review` | Lockfile integrity, pinning, CI actions, image contents, abandoned or risky dependencies | New |
| `design-review` | A design or ADR: assets, new boundaries, STRIDE per crossing, house patterns and invariants. Output: testable security requirements and a verdict, shaped as the security section of the G1 form | New |
| `monitoring-audit-design` | For a capability: events to record, record fields, retention and integrity, readers, alert rules as specifications. Design only | New |

**Engagements and planning:**

| Skill | Procedure | Built from |
|---|---|---|
| `release-review` | Open findings in scope, dependency audit, documents current, security tests present for the changes; verdict | New |
| `security-planning` | Security effort per work item; the costed backlog; the quarterly budget proposal; KPI updates | New |

**One-off:**
- **`appsec-onboarding`** orchestrates the start: clone, read, mental map, cursor, register
  import, supply-chain baseline. It is reused to re-baseline after a long gap.

**For teammates later:** `request-security-review`, the request contract (the copilot only, in
phase 0).

**How they fit together.**
- **The threat model links the two modes.** `change-review` reads it to decide what matters; a
  change that alters a boundary queues a `threat-model-refresh` of that boundary.
- **Scripts for the deterministic parts:** commits since the cursor, file-pattern triage, the
  difference in `npm audit` results since the last baseline, register format checks. They make
  the skills cheaper and more consistent.
- **Objectives to skills:**
  - SEC-1: `change-review`;
  - SEC-2: `findings-register`;
  - SEC-3: `threat-model-refresh`, `vulnerability-hunt`;
  - SEC-4: `advisory-triage`, `supply-chain-review`;
  - SEC-5: `design-review`;
  - SEC-6: `monitoring-audit-design`;
  - SEC-7: `security-planning`;
  - SEC: `security-reporting`;
  - the four foundations: all of them.

**Build order:**
1. Wave 1, for T-01 to T-04: the four foundations, `appsec-onboarding`, `change-review`,
   `advisory-triage`.
2. Wave 2, for T-05 and T-06: `design-review`, `threat-model-refresh`.
3. Wave 3: the rest.

#### Configuration and mental map

**Where the repository comes from.** The repository is a fact about the mission, not one agent:
the code reviewer will share it, and B later makes "a repository per mission" a platform setting.
- **Source of truth: a team file, `team/repositories.json`.** Team files are part of the mission
  config; the daemon writes them to the mission's `team/` folder at every boot; agents read them;
  only the user or the copilot changes them, through the config. The onboarding and review
  scripts read the URL, branch and clone location from it; nothing is hardcoded in a skill.

  ```json
  { "repositories": [ { "name": "magi_v3", "url": "https://github.com/arnadu/magi_v3",
      "branch": "main", "clone": "repos/magi_v3", "visibility": "public" } ] }
  ```

  The shape is that of the future platform setting, so moving to B changes where it is read
  from, not what it says.
- **Mirrored in the mental map's mission context** as one readable line.

**System prompt or mental map.** The system prompt says how to behave: mandate, scope, verdicts,
severity scale, the no-public-issues rule, separation of duties. The mental map holds what to
know: orientation facts and working state.

**Mental map structure.** The platform already makes template content without an `id`
permanent: the agent's editing tools reach only `id`'d elements, and only a config change alters
the rest. Daemon-managed regions are re-rendered each turn.

| Section | Kind | Content |
|---|---|---|
| Mission context | Immutable | Mission; role (`appsec`); supervisor (the user now, the CISO later); the repository and `team/repositories.json`; where the security documents are; the register's location; teammates ("none yet") |
| Standing duties | Immutable | The cadence and the skill for each duty. The schedules are the triggers; this is orientation |
| My objectives | Platform-managed | Objectives, KPIs and tasks from the store (exists) |
| Governance | Platform-managed, later | Authorizations, requests, decisions (E) |
| Review state | Agent-editable | Last commit reviewed and when; last advisory baseline; last trust boundary reviewed in depth and the next in rotation |
| System model notes | Agent-editable | Its own understanding: components and boundaries, how the house patterns are applied, areas of concern, a queue of model sections noted as stale |
| Findings summary | Agent-editable | Counts by severity and status, top open items, a pointer to the register (the register itself stays in `shared/reports/security/register.md`, keeping the mental map small) |
| Requests | Agent-editable | Reviews in progress: who asked, what, by when |
| Questions for the user | Agent-editable | What it is waiting for |
| Lessons | Agent-editable | Calibration over time: false positives, the user's feedback on severity, patterns that proved to matter |
| Working notes | Agent-editable | Scratch for the current task |

**Seed facts; let it discover the analysis.**
- **Seeded:** the repository, document locations, roles, the cadence, empty labelled sections,
  and the review cursor set to `46ca265`, so that T-03 covers exactly the 27 unreviewed commits.
- **Discovered:** its model of the system, written as its own notes during onboarding (T-01).
  The agent exists to give an independent view; seeding it with our summary would hand it our
  blind spots, as same-author review did before the October 2026 audit. Writing the notes is
  also how it learns the codebase.
- **Imported, not seeded:** the register, built from `findings.md` in T-02, so every entry's
  source is known.
- **Empty:** lessons, filled from the user's feedback.

**Growing out of phase 0.** If the mission proves useful, the next step is a brand-new
installation for MAGI DEV, created the way the beta environment for another user was
(`promote.sh --suffix`), with the mission moved there. That is when the separate-installation
design starts to apply, and phase 1 begins.

## Phasing

| Phase | Scope | Needs |
|---|---|---|
| 0 | An infosec specialist, then a code reviewer, read-only, as a mission on the existing installation | Skills ported from the security commands; nothing new in the platform |
| 1 | Community, planning, monitoring reports, on MAGI DEV's own installation | 28h items (#54, #95, G-5); G with its first connectors (GitHub issues and discussions, the mission's repository, read-only); A's read tier (alerts and the daily report included); today's confirmation cards for every external write |
| 2 | Application support | A's action tier, E with the decisions inbox, F, H; the auditor agent |
| 3 | Development and testing | B, C, D; SDLC skills; the evaluation harness (#45) |

## Timeline

Rough sizes in focused working days, at the project's recent pace: estimates, not commitments.

| Phase | Platform work | Rough size |
|---|---|---|
| 0 | None: skills, a template, a launch | **1–2 days** |
| 1 | 28h prerequisites #54, #95, G-5 (~1–1.5 weeks); G with a first GitHub connector (~1–2 weeks); A's read tier, alerts and the daily report included (~1 week); a new installation like beta (~1 day) | **~4–6 weeks** |
| 2 | E, the governance engine (the largest, ~2–4 weeks); the decisions inbox (~1 week); F (~1 week); H (~1 week); the auditor agent | **~6–8 weeks** |
| 3 | B: git proxy and GitHub Apps (~1–2 weeks); C, staging (~1 week); D, sandbox (~1–2 weeks); SDLC skills | **~4–5 weeks** |

**Ways to go faster:**
- **Run phase 0 now, alongside 28h's reliability work.** They do not compete: phase 0 is skills
  and configuration, and its findings may feed 28h.
- **Ship the decisions inbox early**, over today's pending actions: independent of the rest, it
  closes #87 and replaces the chat cards.
- **Sequence phase 1 as the next sprint after 28h's reliability items**, ahead of the feature
  wishlist (interactive apps, illustrations, annotation). The user's call.

## Open questions

- Which repository deploys production: `arnadu/magi_v3` itself, or a new repository while this one stays private? This decides when B must be complete.
- How MAGI DEV is sequenced against the feature wishlist (interactive apps #42, illustrations, document annotation). Interactive apps would also serve D's preview server.
- The initial governance policy: which actions start autonomous, which start approve-first, and what track record loosens them (see the governance engine's open questions).

## Appendix: the gateway in pseudo-code

Illustrative TypeScript-like pseudo-code for G: what the platform code does and what is data.
Provider endpoints are as currently understood and are to be confirmed when built.

### 1. Connectors (data)

```yaml
# connectors/fly.yaml — the Fly Machines API, for MAGI DEV's own staging installations
id: fly
baseUrl: https://api.machines.dev/v1
egress: [api.machines.dev]
credential: { adapter: fly, narrowTo: [app] }   # the token is restricted to the app in the path
operations:
  - { id: list-machines,   method: GET,  path: /apps/{app}/machines,                   class: read }
  - { id: get-machine,     method: GET,  path: /apps/{app}/machines/{machine},         class: read }
  - { id: restart-machine, method: POST, path: /apps/{app}/machines/{machine}/restart, class: action }
  - { id: stop-machine,    method: POST, path: /apps/{app}/machines/{machine}/stop,    class: action }
```

```yaml
# connectors/github.yaml — REST API; git itself goes through the git proxy
id: github
baseUrl: https://api.github.com
egress: [api.github.com]
credential: { adapter: github-app, narrowTo: [owner, repo] }   # App chosen by the caller's role
operations:
  - { id: list-issues,       method: GET,  path: /repos/{owner}/{repo}/issues,                   class: read }
  - { id: get-check-runs,    method: GET,  path: /repos/{owner}/{repo}/commits/{ref}/check-runs, class: read }
  - { id: create-issue,      method: POST, path: /repos/{owner}/{repo}/issues,                   class: action }
  - { id: open-pull-request, method: POST, path: /repos/{owner}/{repo}/pulls,                    class: action }
  - { id: review-pull,       method: POST, path: /repos/{owner}/{repo}/pulls/{number}/reviews,   class: action }
  - { id: draft-advisory,    method: POST, path: /repos/{owner}/{repo}/security-advisories,      class: action }
```

```yaml
# connectors/atlas.yaml — the Atlas Admin API
id: atlas
baseUrl: https://cloud.mongodb.com/api/atlas/v2
egress: [cloud.mongodb.com]
headers: { Accept: application/vnd.atlas.2023-01-01+json }
credential: { adapter: atlas-service-account, narrowTo: [group] }
operations:
  - { id: list-snapshots, method: GET,  path: /groups/{group}/clusters/{cluster}/backup/snapshots, class: read }
  - { id: list-alerts,    method: GET,  path: /groups/{group}/alerts,                              class: read }
  - { id: restore-job,    method: POST, path: /groups/{group}/clusters/{cluster}/backup/restoreJobs, class: action }
```

```yaml
# connectors/magi-ops.yaml — production's Ops API (deliverable A)
id: magi-ops
baseUrl: https://magi-control.fly.dev/ops/v1
egress: [magi-control.fly.dev]
credential: { adapter: magi-ops, narrowTo: [] }
operations:
  - { id: mission-status, method: GET,  path: /missions/{mission},        class: read }
  - { id: anomalies,      method: GET,  path: /anomalies,                 class: read }
  - { id: daily-report,   method: GET,  path: /reports/daily/{date},      class: read }
  - { id: resume-mission, method: POST, path: /missions/{mission}/resume, class: action }
```

### 2. Policy (data, part of the mission policy)

```yaml
grants:
  - agent: appsec
    connector: github
    operations: [list-issues, get-check-runs, draft-advisory]
    where: { owner: arnadu, repo: magi_v3 }
    level: { list-issues: autonomous, get-check-runs: autonomous, draft-advisory: approve-first }
  - agent: sre
    connector: fly
    operations: [list-machines, get-machine, restart-machine]
    where: { app: "magi-staging-*" }        # production apps are never granted on this connector
    level: { list-machines: autonomous, get-machine: autonomous, restart-machine: notify-after }
  - agent: sre
    connector: magi-ops
    operations: [mission-status, anomalies, daily-report, resume-mission]
    level: { resume-mission: approve-first }
limits:
  - { connector: fly,    perAgentPerHour: 120 }
  - { connector: github, perAgentPerHour: 300 }
```

### 3. The generic tool (agent-facing)

```ts
// One tool for every REST connector. Its execute() runs in the daemon, which attaches the
// caller's identity: the agent cannot claim to be someone else.
const ApiCall = tool({
  name: "ApiCall",
  description:
    "Call an external API through the mission's gateway. Credentials are added for you; you " +
    "never see or handle them. Only operations granted to you in the mission policy succeed; " +
    "your skills say which connector and path to use for a task.",
  parameters: {
    connector: string,                          // "fly", "github", "atlas", "magi-ops", …
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,                               // relative to the connector's base URL
    query?: Record<string, string>,
    body?: unknown,
  },
  async execute(args, ctx) {
    // Local socket to the gateway, which runs under its own OS user.
    return gatewaySocket.send({ ...args, caller: { agent: ctx.agentId, mission: ctx.missionId } });
  },
});
```

### 4. The gateway (mission machine, own OS identity)

```ts
async function handle(req: ApiRequest): Promise<ToolResult> {
  const conn = connectors.get(req.connector);
  if (!conn) return refuse(`unknown connector "${req.connector}"`);

  // Match against the catalogue: method + path pattern → operation and its parameters.
  const match = conn.match(req.method, req.path);   // e.g. { op: "restart-machine", params: { app, machine } }
  if (!match) return refuse(`no ${conn.id} operation matches ${req.method} ${req.path}`);
  if (!conn.validBody(match.op, req.body)) return refuse("body does not match the operation's schema");

  // Governance check, in the daemon (E): grants, targets, level, limits, approvals.
  const d = await governance.authorize({ caller: req.caller, connector: conn.id, op: match.op, params: match.params });
  if (d.kind === "deny")    return refuse(d.reason);                  // e.g. "fly: app magi-missions is not granted"
  if (d.kind === "pending") return waiting(d.requestId);              // the user decides in the inbox; the agent resumes later

  // A credential narrowed to this target and this kind of access.
  const scope = { ...pick(match.params, conn.credential.narrowTo), access: conn.classOf(match.op) };
  const cred = await credentials.get(conn.credential.adapter, scope, req.caller);

  const res = await safeHttp(conn.baseUrl + req.path, {
    method: req.method, query: req.query, body: req.body,
    headers: { ...conn.headers, Authorization: `Bearer ${cred.token}` },
    allowedHosts: conn.egress, timeoutMs: 30_000, maxBytes: 2_000_000,
  });

  await audit.write({ caller: req.caller, connector: conn.id, op: match.op, params: match.params,
                      status: res.status, bytes: res.bytes, decision: d.id });
  if (d.level === "notify-after") await notifyUser(req.caller, conn.id, match.op, match.params, res.status);
  return untrusted(res.body);                                         // wrapped, size-capped, never the credential
}

// Short-lived credentials, cached in the gateway's memory only.
async function get(adapter: string, scope: Scope, caller: Caller): Promise<Credential> {
  const cached = cache.find(adapter, (c) => covers(c.scope, scope) && c.expiresAt > now() + 60_000);
  if (cached) return cached;
  const fresh = await broker.issue({ adapter, scope, mission: caller.mission, agent: caller.agent });
  cache.put(fresh);
  return fresh;
}
```

### 5. The git proxy (mission machine, inside the gateway)

```ts
// The agent's clone has a remote like http://127.0.0.1:7410/magi_v3.git, with no token.
async function onPush(caller: Caller, repo: string, updates: RefUpdate[]) {
  for (const u of updates) {
    const d = await governance.authorize({ caller, connector: "github", op: "push-branch",
                                           params: { repo, branch: u.ref } });   // e.g. only wi/<item>-* for approved items
    if (d.kind !== "allow") return rejectPush(u.ref, d.reason);                  // git shows the reason to the agent
  }
  const cred = await credentials.get("github-app", { repo, access: "write" }, caller);
  await forwardPush(`https://github.com/${repo}.git`, updates, cred);            // token added here, never in the clone
  await audit.write({ caller, connector: "github", op: "push-branch", params: { repo, refs: updates.map((u) => u.ref) } });
}
```

### 6. The broker (control plane)

```ts
// POST /broker/credentials — called only by mission gateways, each authenticated by its
// machine identity (Fly OIDC, to be confirmed) or a per-mission token.
async function issue(req: { adapter: string; scope: Scope; mission: string; agent: string }) {
  // Second, independent check: the mission's grants are read from the database, not from the request.
  const grants = await policy.grantsFor(req.mission, req.agent);
  if (!grants.allowsScope(req.adapter, req.scope)) return refuse("scope not granted to this mission");

  const root = rootSecrets[req.adapter];             // Fly secrets today; a managed store later
  const cred = await adapters[req.adapter].mint(root, req.scope, ttlFor(req.adapter, req.scope));
  await audit.write({ mission: req.mission, agent: req.agent, adapter: req.adapter, scope: req.scope,
                      expiresAt: cred.expiresAt });
  return cred;                                        // { token, scope, expiresAt }; root never leaves
}
```

### 7. Credential adapters (control plane, one per provider)

```ts
const adapters = {
  // Fly tokens are macaroons: the holder of a broad token can add restrictions without a network call.
  // To confirm: which restrictions Fly honours; fallback: create an app-scoped token with an expiry via Fly's API.
  fly: { mint: (root, { app, access }, ttl) =>
    attenuate(root, [appIs(app), access === "read" ? readOnly() : machinesOnly(), expiresIn(ttl)]) },

  // A JWT signed with the App's private key proves the App's identity; GitHub returns a 1-hour token
  // narrowed to the repositories and permissions asked for.
  "github-app": { mint: async (appKeys, { owner, repo, access, role }) => {
    const jwt = signJwt({ iss: appKeys[role].appId, exp: now() + 540 }, appKeys[role].privateKey);
    const t = await post(`https://api.github.com/app/installations/${appKeys[role].installationId}/access_tokens`,
      { repositories: [repo], permissions: access === "read" ? { contents: "read", issues: "read" }
                                                             : { contents: "write", pull_requests: "write" } },
      { Authorization: `Bearer ${jwt}` });
    return { token: t.token, expiresAt: t.expires_at };
  } },

  // OAuth client credentials for an Atlas service account: a token valid about an hour.
  "atlas-service-account": { mint: async (sa) => {
    const t = await post("https://cloud.mongodb.com/api/oauth/token",
      form({ grant_type: "client_credentials" }), basicAuth(sa.clientId, sa.clientSecret));
    return { token: t.access_token, expiresAt: now() + t.expires_in * 1000 };
  } },

  // OpenRouter: a provisioning key creates a key with its own credit limit; deleted when its time is up.
  openrouter: { mint: async (provisioningKey, { purpose, limitUsd }, ttl) => {
    const k = await post("https://openrouter.ai/api/v1/keys", { name: `magi-dev ${purpose}`, limit: limitUsd },
      { Authorization: `Bearer ${provisioningKey}` });
    scheduleDelete(k.hash, now() + ttl);
    return { token: k.key, expiresAt: now() + ttl };
  } },

  // Production's Ops API: exchange MAGI DEV's client credential at production's token endpoint.
  "magi-ops": { mint: async (client) => {
    const t = await post("https://magi-control.fly.dev/ops/v1/token",
      form({ grant_type: "client_credentials" }), basicAuth(client.id, client.secret));
    return { token: t.access_token, expiresAt: now() + t.expires_in * 1000 };
  } },
};
```

### 8. A skill that uses it

```markdown
---
name: staging-machines
description: Inspect and restart the machines of MAGI DEV's staging installations on Fly.io.
---
# Staging machines

## Find a stuck machine
ApiCall({ connector: "fly", method: "GET", path: "/apps/magi-staging-missions/machines" })
Look at each machine's `state`. A machine in `replacing` or `starting` for more than ten minutes is
stuck; check its `events` for the last exit.

## Restart it
ApiCall({ connector: "fly", method: "POST", path: "/apps/magi-staging-missions/machines/<id>/restart" })
The user is notified afterwards. Production machines are never touched through the `fly`
connector: a production mission is resumed through `magi-ops` (`POST /missions/<id>/resume`),
which asks the user first.
```

### What each piece is

| Piece | Kind | Where |
|---|---|---|
| `ApiCall`, the git proxy, the gateway's matching, governance call, cache, audit | Platform code, written once | Mission machine |
| The broker and about five adapters | Platform code, one adapter per provider | Control plane |
| Connectors | Data, imported from OpenAPI where possible | Mission configuration |
| Grants and limits | Data, under the governance engine | Mission policy |
| How to do a task | Skills | Mission skills |
