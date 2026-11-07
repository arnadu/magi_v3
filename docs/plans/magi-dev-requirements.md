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

The objectives below reduce to six platform capabilities. Everything else is mission
configuration (team, skills, schedules) that can be iterated without platform changes.

| # | Deliverable | Content | Existing base |
|---|---|---|---|
| A | **Production Ops API** | A service identity for MAGI DEV, separate from `CONTROL_API_KEY`, with short-lived tokens. A read tier with no approval: mission status and health, anomalies, logs (through the control plane), stats and spend, resource samples, a mission's files and transcripts. An action tier, each action under the approval policy (E): suspend, resume, rollout, rollback, fork a volume, raise a cap. Every call recorded in production's audit log. A push channel: production's hard anomalies and daily report forwarded to MAGI DEV's mailbox through an authenticated inbound endpoint. New trust boundary: threat-model entry and ADR. | Missions API and copilot actions; anomaly relay; daily report |
| B | **GitHub release control** | The GitHub proxy targets a configurable repository per mission and gains git push (branches only) and pull-request operations. Per-role credentials held by MAGI DEV's control plane, never in agent environments: developers push branches and open pull requests; a release manager tags and requests releases; none can bypass protection. Branch protection on `main`, the existing gates as required checks, and a "production" GitHub Environment whose required reviewer is the operator at first, a policy later. | GitHub proxy (issues only, one repo, `GITHUB_REPO`); CI gates |
| C | **Staging installation** | A full MAGI stack (control plane, missions app, database) that CI deploys release candidates to. Runs the full integration suite, OS-isolation tests included, and an end-to-end smoke test: launch a test mission, check it runs, resume it, roll it out. | `promote.sh --suffix` named environments |
| D | **In-VM sandbox** | Build, lint, unit tests and lightweight integration tests against a local `mongod`, never MAGI DEV's own database. LLM calls from tests go through a Tool API proxy that speaks the provider API, metered against a test budget; no raw key in the sandbox. A cockpit dev server previewed through BrowseWeb, which needs a sanctioned exception to the loopback block. A bigger default machine shape. | Tool API metering for jobs (`createJobSpend`); machine shapes (28g) |
| E | **Approval-policy engine** | Per action type: autonomous, notify-after, or approve-first, editable by the operator, loosening as a track record accumulates. Applies across MAGI DEV: publishing, Ops API actions, merges, releases, spend. | Copilot confirmation cards (`ProposeAction`) |
| F | **Mission rollout and rollback** | A deploy only changes the image for new machines; running missions pick it up on suspend and resume. Production needs a rollout action: canary mission first, health check, then the rest, with automatic rollback. Triggered through A. | In-place resume (#103) |

Rule for MAGI DEV's own installation: it runs the previous stable release and is upgraded only
after production has run a release cleanly for some days. The operator, or a coding-agent
session, is the emergency fallback if MAGI DEV breaks itself.

## Objectives and their technical requirements

In the lists below:
- **[exists]** means it is in the platform today;
- **[partial]** means part of it is there;
- **[new]** means it needs building.

Letters refer to the deliverables above.

### Cross-cutting

- **Decision rights** (E) [partial].
- **Proxied access to every external system** (A, B, channel connectors): agents never hold raw credentials [partial].
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

## Phasing

| Phase | Scope | Needs |
|---|---|---|
| 1 | Community, planning, monitoring reports | 28h items (#54, #95, G-5); B's per-mission repository; read-only use of A or, before A exists, reports from production's daily report |
| 2 | Application support | A (read and action tiers), E, F; auditor agent |
| 3 | Development and testing | B in full, C, D; SDLC skills; evaluation harness |

## Open questions

- Which repository deploys production: `arnadu/magi_v3` itself, or a new repository while this one stays private? This decides when B must be complete.
- How MAGI DEV is sequenced against the feature wishlist (interactive apps #42, illustrations, document annotation). Interactive apps would also serve D's preview server.
- The initial approval policy: which actions start autonomous, which start approve-first, and what track record loosens them.
