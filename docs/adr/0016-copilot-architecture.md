# ADR-0016 — Copilot Architecture: Mission-Scoped Supervision + Control-Plane Portfolio Assistant

**Status**: Proposed
**Sprint**: 26
**Date**: 2026-07

## Context

The copilot today is a single shared identity (`copilot-{userId}`) running on the control
plane, asked to play two incompatible roles at once: cross-mission portfolio assistant (compare
missions, launch new ones, answer "what's my spend this month") and in-mission supervisor
(diagnose a stuck agent, correct a teammate's drifted objective, fix that mission's config).
Those roles want opposite scoping: the first is inherently cross-mission; the second must never
see past its own mission. Forcing one identity to do both produced four independently-discovered
bugs, all the same root cause, merged into **GitHub #19**:

- **#14** — no mission boundary on writes; talking to the copilot from mission A can mutate
  mission B (confused-deputy, write side).
- **#6** — five read tools (`ListMissions`/`GetMissionStatus`/`ReadMissionMailbox`/
  `ReadMissionLog`/`ReadMissionFile`) had no `userId` filter at all (confused-deputy, read side,
  found independently of #14).
- **#16** — asked to diagnose a stuck agent, the copilot guessed at causes instead of pulling
  turn-level evidence, misdiagnosing a real hang twice — it has no structured diagnostic tooling
  reaching into a mission's actual execution state.
- A live-incident finding, this sprint: the copilot correctly told an operator it *couldn't* read
  a mission agent's mental map — confirmed true by code inspection. Same class of gap as #16,
  broader than the narrow case #16 was originally scoped around.

The question this ADR answers: how do we split this into an architecture where each role gets
the scoping it actually needs, without either duplicating the entire tool surface twice or
building a new isolation mechanism from scratch.

## Decision

Split into two agents with two different trust models, not one agent with a parameter:

1. **Mission copilot** — a normal execution-plane agent, one per mission, auto-injected by the
   daemon. Gets mission isolation *for free* from the isolation every execution-plane agent
   already has — no new mechanism.
2. **Control-plane copilot** — keeps its current architecture (control-plane process, one per
   user, `userId`-scoped), scope narrowed to what's genuinely cross-mission, with its existing
   `userId`-filter bugs fixed (Track 1).

### General — principles that apply to both

- **Reuse the existing agent loop.** Both copilots run through `runAgent`/`runInnerLoop` — no
  parallel agent-loop implementation for either. The mission copilot is provisioned exactly like
  any other team member (`WorkspaceManager.provision()`, per-agent `linuxUser`, ACL); the
  control-plane copilot keeps its existing standalone `runAgent` call with `additionalTools`.
- **Structural scoping over parameter-checked scoping, wherever structural scoping is available.**
  This is the actual lesson from #14/#6: a tool whose LLM-facing schema takes `missionId` (or
  `userId`) as a free parameter is one omitted `if` away from a confused-deputy bug — proven
  twice, independently, in the same codebase. Every execution-plane repository already closes
  over `missionId` at construction time and no agent tool schema takes it as a parameter — this
  is *why* design (1) closes #6's entire bug class by construction rather than by code
  discipline, and it's why the mission copilot's contract is stricter than anything the
  control-plane copilot can offer: **every new mission-copilot tool takes zero
  mission-identifying parameters.** The control-plane copilot cannot get the same structural
  guarantee (it is inherently cross-mission by role) — Track 1's `userId`-filter fix is the best
  available approximation for the tools that must stay there, not a weaker version of the same
  mechanism.
- **Context management is inherited, not bespoke, but must be re-verified on every tool-surface
  change.** Sprint 9's session-boundary reflection (`reflection.ts`) generically truncates any
  tool result to 2 KB when summarizing a closed session — this holds for any future tool, no
  changes needed. Sprint 21's mid-session pruning (`context-utils.ts`) does **not** generalize —
  it gates on a hardcoded `EPHEMERAL_TOOLS` allowlist by tool name. Confirmed gap for this plan:
  none of the mission copilot's new large-result tools were in that Set; a fix adds
  `ReadAgentSessionDetail`, `ReadAgentLlmCall`, `ReadMissionMailboxAll`, `SearchMissionHistory`,
  `ReadSharedFile`, `ReadAgentWorkdirFile`, `ReadMissionLog` to it. This is now a standing
  checklist item for *any* future large-result tool added to either copilot, not a one-time fix —
  nothing else in the codebase forces a developer adding a new tool to remember this file exists.
- **Elevated/mutating tools are audited for confirmation-gating case by case, not uniformly** —
  the control-plane copilot's existing unconfirmed GitHub write (**F-021**) and the mission
  copilot's new one (**F-023**, this plan) are recorded as the same open question in two places,
  deliberately not resolved identically yet. Both are expected to get a real `ProposeAction`-style
  gate once cockpit repointing (Sprint 26b+) gives *both* copilots a UI surface to confirm
  against.
- **Security detail lives in the threat model, not duplicated here.** See
  `docs/security/threat-model.md` TB-15/TB-16 (control-plane copilot, existing) and TB-17/TB-18/
  TB-19 (mission copilot, new) for the full boundary-by-boundary analysis; this ADR states the
  architectural choice and its consequences, not the STRIDE table.

### Control-plane copilot — narrowed, not eliminated

Earlier in this sprint's design discussion the question was raised directly: once the mission
copilot exists and can do in-mission config/diagnosis itself, does the control plane need a
copilot at all? **Conclusion: yes, but its job shrinks to what is inherently cross-mission** —
things no single mission's agent could ever answer, because the answer spans missions the
mission copilot structurally cannot see:

- Portfolio-level Q&A ("what's my spend this month across all missions", "which of my missions
  are stuck") — `ListMissions`/`GetMissionStatus`/`ReadMissionLifetimeStats`-equivalent, now
  correctly `userId`-scoped (Track 1).
- Template authoring/versioning — templates aren't mission-scoped data, they're the *inputs* to
  creating a mission.
- Launching, suspending, and resuming missions — the mission copilot cannot suspend or resume
  its own mission (it wouldn't be running to do so), so this stays a control-plane action,
  `ProposeAction`-gated as today.
- Its existing GitHub tools (`ListIssues`/`CreateIssue`/`CloseIssue`/`AddIssueComment`) are
  **unchanged** — it already has direct `GH_TOKEN` access because it *is* the control plane; the
  new proxy (TB-19) exists solely to let the *execution* plane reach GitHub without ever holding
  that token, and has no bearing on the control-plane copilot's own tools.

What moves out: in-mission diagnosis, config edits, and objective correction — all of #16's and
the live-incident finding's territory — are now the mission copilot's job, done with direct
access instead of the control-plane copilot proxying in through `ReadMissionMailbox`/
`ReadMissionFile`. This is not left merely implicit: **Track 3** rewrites the control-plane
copilot's own system prompt (`config/teams/copilot.yaml`) to say so explicitly — it now names
the mission copilot, states the coarse-vs-direct distinction in operator-facing terms, and
replaces its stale "Troubleshooting"/"Agent coaching" role bullets with a "Triage" bullet that
routes in-mission questions to the right place instead of attempting them secondhand. Track 3
also fixes a second, independently-verified gap: the control-plane copilot's own Docker image
never bundled `MAGI_V3_SPEC.md` — the same "reverse-engineer the tool catalog from raw code
instead of the maintained doc" problem this plan already solved for the mission copilot, just on
the other side. This plan does **not** remove any existing control-plane copilot *tool* as part
of this work (that's a larger, separate decision requiring real usage data from a running
mission copilot first) — Track 1 fixes data scoping, Track 3 fixes self-description; neither
touches the tool surface. Reducing the control-plane copilot's tool surface once the mission
copilot has proven out in production is explicitly deferred, tracked as a follow-up, not designed
here.

### Mission copilot — the new agent

**What it is**: an execution-plane agent, daemon-injected into every mission's roster at a fixed
id (`"copilot"`, reserved), given a superset of Tier-A tools plus a new elevated tool family
(Families A–G) that reads across every teammate in its own mission and writes into shared mission
state (config, objectives, another agent's mental map).

**Why an execution-plane agent (design A) and not a mission-keyed control-plane daemon (design
B, as #14 originally proposed)**: (A) forecloses #6's entire bug class *structurally* — there is
no `missionId` parameter to forget to check, because there is no cross-mission code path at all;
a mission copilot process simply has no way to reach another mission's Mongo documents or
filesystem, the same as any other agent. (B) would have required building a new isolation
mechanism (careful `missionId` threading through every tool, exactly the pattern that already
failed twice) to simulate what (A) gets for free. (A) is also demonstrably cheaper to build than
#14 assumed: `monitor-server.ts` already exposes almost every diagnostic route this agent needs
on its own machine's loopback interface — most of its tools are thin `fetch()` wrappers over
existing routes, not new backend surface. Not all, though: `ReadAgentUsage`'s route needed its
response extended, `EditAgentMentalMap` needed a wholly new write route, and
`CancelBackgroundJob`/`RestartBackgroundJob` needed a new job-process registry that didn't exist
in any form.

**The trade-off this decision accepts, stated explicitly rather than left implicit**: the mission
copilot breaks the containment property every other agent in this system has. Every other agent's
blast radius from a prompt injection (e.g. via `FetchUrl`/`BrowseWeb` ingesting poisoned external
content — existing TB-8) is self-contained: it can corrupt only its own mental map, files, and
mailbox. The mission copilot reads every teammate's mailbox/mental-map/transcripts/files and can
write into a teammate's mental map and the whole team's config — a successful injection against
it can propagate to every agent it supervises. This is not a gap to be closed later; it is
accepted as the cost of the supervisory role, mitigated (not eliminated) by two mechanisms
required, not optional, at ship time:
1. Every read tool that returns free-text content another agent could have influenced is wrapped
   in the same trust-boundary markers `BrowseWeb` already uses for untrusted external content
   (TB-8) — not just mental-map/transcript reads, but file reads (`ReadSharedFile`/
   `ReadAgentWorkdirFile`) and `ReadMissionConfig`'s attached team files too.
2. Every mutating tool posts a mandatory audit-trail message to the user's mailbox on every call.
   Only `SaveMissionConfig` has a grace period (next-resume delay); every other mutating tool —
   `EditAgentMentalMap`, `PauseAgent`, `ResumeAgent`, `CreateScheduledMessage`,
   `CancelScheduledMessage`, `CancelBackgroundJob`, `RestartBackgroundJob`, `SetMissionSpendCap`
   — is immediate, with the audit post as the only check (**F-026**).

**Why GitHub reporting goes through a new control-plane proxy, not direct execution-plane
`GH_TOKEN` access**: keeps `GH_TOKEN` a control-plane-only secret — the same reasoning that
already keeps `MONITOR_SIGNING_KEY` off every execution-plane machine (TB-11). The mission
already holds a per-mission `MONITOR_TOKEN` derived from that signing key; the proxy re-derives
and compares it rather than trusting a `missionId` the request body claims — the token, not the
field, is what's unforgeable, which is the same structural-over-parameter principle applied to a
cross-boundary call instead of a same-process one.

**Why config edits apply on next resume, not live**: matches the existing constraint every
config edit already has today (`daemon.ts` reads `TEAM_CONFIG` once at boot, never re-reads
Mongo mid-run) — building live-apply would be new machinery solving a problem this plan doesn't
need to solve in v1, and the audit-mailbox-post gives the user a review point before the change
takes effect on the next resume regardless.

**Why the mission copilot is daemon-injected, not template-declared**: every mission gets one,
unconditionally, the same way every mission already gets `ensureAgentUsers`/ACL provisioning —
making it YAML-optional would mean some missions silently ship without the one agent responsible
for noticing when the rest of the team has drifted, which defeats the purpose. Reserved-id
validation prevents an authored team config from colliding with or spoofing it — and, together
with the fact that elevated-tool grant is keyed on the literal agent id `"copilot"` in code
(never on anything YAML-controlled), makes it structurally impossible for a compromised copilot
to escalate a different agent to its own privilege level via `SaveMissionConfig`.

**How it monitors alignment** (the concrete mechanism, not just an aspiration): a self-scheduled
recurring review that, per teammate, compares three things — the objective actually assigned,
what the agent believes it's doing (its mental map), and what it actually did (its session
transcripts) — plus a cost-vs-progress cross-check. Three specific disagreement patterns get
three different responses (stale mental map → direct correction; belief vs. behavior mismatch →
investigate as a possible bug; objective vs. behavior mismatch despite accurate self-belief → the
actual drift case, escalate to the user rather than guess). Findings are recorded as a KPI, which
is what gives it a real value instead of sitting permanently unset.

## Consequences

**Positive**: closes #14/#16/#6/#2 (already merged into #19) with a design that forecloses the
underlying bug class rather than patching each symptom; gives every mission an always-on,
correctly-scoped in-mission lead without waiting on operator attention; makes GitHub bug reports
evidence-based (turn/timestamp citations, not "seemed stuck"); closes the mailbox-notification
half of the pre-existing, unrelated **#3** as a side effect of the alert-routing extension.

**Costs and risks knowingly accepted, not deferred silently**:
- Prompt-injection blast-radius increase for this one agent (see above) — mitigated, not
  eliminated; the mitigations are load-bearing, not optional polish.
- **F-023**: `ReportGithubIssue` has no confirmation gate in v1 (same open question as the
  control-plane copilot's existing **F-021**) — mitigated with rate-limiting, a forced
  `mission-copilot` label, and a server-appended provenance footer; a real gate is deferred to
  when either copilot gets a confirmable UI surface.
- **F-025**: the mission copilot can raise its own mission's hard spend cap unconfirmed,
  including — self-referentially — funding its own further calls; recorded as an open question
  with both options (accept vs. cap the increase) rather than decided silently in code.
- **F-026**: every mutating tool other than `SaveMissionConfig` is immediate (no resume-delay
  grace period) with only a same-turn audit post as its check — a compromised copilot could pause
  every teammate, cancel every scheduled review, or kill every background job in one turn, fully
  unconfirmed. Same open-question class as F-021/F-023, tracked separately because the blast
  radius (whole-team operational disruption, not one external write) is categorically larger.
- The 7-day `llmCallLog` retention window means `ReadAgentUsage`'s `toolNames` and all of
  `ReadAgentLlmCall`'s detail are unavailable for calls older than a week — model/tokens/cost
  survive indefinitely, call content and tool names do not. This is an existing pruner behavior,
  not new, but the mission copilot is the first agent whose job depends on querying it regularly
  enough that the boundary needs to be taught explicitly rather than discovered as an unexplained
  gap.
- Background-job "restart" runs the resubmitted job under the mission copilot's own OS identity,
  not the original submitter's — correct for the common case (jobs writing to `sharedDir`), a
  known sharp edge for a job originally scoped to a specific agent's own workdir.
- `/opt/magi-src/` read access on the execution plane is a new, deliberate widening of what a
  compromised execution-plane process could exfiltrate or describe (e.g. citing exact ACL/SSRF
  logic in a filed GitHub issue) — accepted because equivalent access already exists on the
  (higher-trust) control plane with no incident, the source contains no secrets, and the access
  exists specifically to make bug reports good enough to be worth filing. Scoped to *only* this
  agent's `AclPolicy.permittedPaths`, not a blanket change.

**Explicitly deferred, not designed here**: self-service config apply/resume (no live-apply in
v1); cockpit repointing to give either copilot a confirmable UI surface; reducing the
control-plane copilot's tool surface now that the mission copilot exists; any `AskUser`/
awaiting-input mechanism for either copilot.

## Related

- GitHub #14, #16, #6, #2 — merged into **#19**, which this ADR's two-track plan (Track 1
  immediate fix, Track 2 this design) implements.
- GitHub #3 — background job failures not surfaced anywhere; the alert-routing extension closes
  the mailbox-notification half as a side effect.
- ADR-0009 (context management / reflection) — this ADR's context-management principle directly
  extends its mid-session-pruning mechanism to a new tool surface.
- ADR-0015 (MonitorServer HMAC-derived auth) — the GitHub proxy reuses this exact
  derive-and-compare mechanism, in the reverse direction (execution plane → control plane
  instead of control plane → execution plane).
- `docs/security/threat-model.md` — TB-15/TB-16 (control-plane copilot, existing), TB-17/TB-18/
  TB-19 (mission copilot, new).
- `docs/security/findings.md` — F-021 (existing, control-plane copilot unconfirmed GitHub write),
  F-023/F-024/F-025/F-026 (new, this plan).
