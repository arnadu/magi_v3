---
name: mission-leadership
description: |
  Operational playbook for the mission copilot: how to read cheaply, write
  good objectives, understand the two-tier budget model, author a teammate's
  prompt or mental-map note well, and create a new skill. Your system prompt
  already covers who you are, your responsibilities, the investigation
  method, and the alignment-check procedure — this skill is the "how", not
  the "why".
---

# Mission leadership

## Read cheap-first — this is not optional politeness, it's how you avoid burning your own context every turn

Your job means reading other agents' state constantly — mental maps, transcripts, mailboxes,
call logs. An unbounded or all-detail-by-default read here is the single most common way you'd
burn through your own context window doing routine work. Escalate in this order, every time:

1. **Summary tools first**: `ListAgentSessions`, `ReadAgentUsage` return small, structured data
   (turn metadata; per-call cost + tool *names*, not bodies). Start here, always.
2. **Detail tools only once a summary has pointed at something specific**: `ReadAgentSessionDetail`
   (one full turn) and `ReadAgentLlmCall` (one full call) cost proportionally more — reach for
   them once you know *which* turn or call is worth reading in full, not to browse.
3. **Search before you browse broadly**: `SearchMissionHistory` returns excerpts, not full
   messages. If the question is "did anyone mention X" rather than "show me everything", this is
   the cheapest way to find it — prefer it over `ReadMissionMailboxAll`/`ReadAgentSessionDetail`
   when you're looking for something specific.
4. **Every list-returning tool defaults to a bounded recent window**, not a mission's entire
   history (`ListAgentSessions` defaults to 50 turns, `ReadMissionMailboxAll` to 20 messages,
   `ReadMissionCostSeries` to 100 turns). Trust the default unless you have a specific reason to
   widen it — a long-running mission's *entire* history is exactly the kind of thing worth
   capping by default.

**Retention**: `ReadAgentUsage`'s `toolNames` and all of `ReadAgentLlmCall`'s content are only
available for calls within the last 7 days — older calls still show model/tokens/cost (kept
indefinitely for billing), just not what tools ran or what was said. This is expected, not a
bug — don't burn a turn trying to work around it for old calls.

## Writing objectives that are concrete without being over-prescriptive

A good objective states an *outcome that should be true*, not a checklist of activities — that's
what leaves room for the owning agent to use judgment about how to get there, while still giving
you (and the user) something unambiguous to check progress against. "This mission's parameters
serve the user's actual intent" is checkable; "review the config every Tuesday" is a task, not an
objective. When you define or correct a teammate's objective:

- State the outcome, not the procedure.
- Give it a KPI wherever possible — even a qualitative rubric (`met`/`partial`/`unmet`) beats no
  measure at all, because it's what turns "I think this is going fine" into something you can
  actually track drift against on your next alignment review.
- Assign a clear owner — the agent accountable for the KPI moving, not just whoever happens to
  touch it most.
- Don't create an objective for something that's really a one-off task — use a task under an
  existing objective instead. Objective sprawl makes the tree harder to read for everyone,
  including the user.

## The two-tier budget model

Two genuinely different concepts, both called "budget" — don't conflate them:

- **Objective-level `budgetUsd`** (on any node in the tree, including `OBJ-RESOURCES`) — soft,
  informational, auto-attributed from real per-turn spend. Edited directly in `goals.json` via
  the objectives skill's normal mechanism — no elevated tool needed. Use this to track whether
  spend on a piece of work is proportionate to what it's producing.
- **`SetMissionSpendCap`** — hard, pauses the *entire mission* if exceeded. A safety valve, not a
  tracking mechanism. Raise it only when the mission's actual objectives justify it, and remember
  it's self-referential: raising it also funds your own further calls, which is exactly why it's
  audit-posted every time.

## Authoring a teammate's system prompt or mental-map note well

When you edit a teammate's `systemPrompt` via `SaveMissionConfig`, or leave them a
`#supervisor-note` via `EditAgentMentalMap`, favor the same shape your own system prompt already
models:

- **A clear role statement** — what this agent is *for*, in one or two sentences, before any list
  of responsibilities.
- **Explicit boundaries** — what it should *not* do, stated as plainly as what it should.
- **Concrete "how to do X" procedures over vague responsibility lists.** A vague prompt
  ("investigate issues carefully") is exactly what produces guessing instead of evidence-backed
  diagnosis — state the actual steps, the way your own "Investigate before you conclude" section
  does.

A `#supervisor-note` is not the same kind of document as a system prompt, though — it's read once
on the target's next turn, not a persistent reference the way their own `#working-notes` are.
Keep it short, dated (the render already timestamps it, so you don't need to restate that), and
focused on one thing. If you find yourself writing several paragraphs, the content probably
belongs in a corrected objective or a config change instead.

### Which surface: prompt, skill, or mental map?

Before you edit a teammate's system prompt, write them a skill, or leave a mental-map note,
decide which one actually fits — mixing these up is a common way advice gets stale or costs
context it doesn't need to.

- **Skill** — true regardless of the mission, worth fixing once and having it reach everyone
  automatically. Skills are re-copied fresh into `shared/skills` on every provision (including
  every resume), so a fix you make later propagates without you touching any running mission;
  only the one-line description costs context every turn, the body is read on demand. Several
  paragraphs of "how to do X" is almost always this — see "Creating a new skill" below.
- **Mental map** — specific to *this* agent's own unfolding history, expected to keep changing
  as the mission runs. It's the only surface that's fully visible every turn with no on-demand
  step, so keep entries short and factual (what happened, what you did), not reference material.
- **System prompt** — role, boundaries, and standing behavior that's always relevant regardless
  of history, and that the agent needs without having to think to go check somewhere else.
  Capability details ("how do I diagnose X") belong in a skill instead — see
  `magi-template-design`'s System prompt design section for the fuller version of this rule,
  written for whoever's designing a brand-new agent from scratch.

## Creating a new skill for the team

Prefer the `skill-creator` skill's scaffold (`init_skill.sh`) over hand-writing a new `SKILL.md`
from scratch — it produces the same shape every other agent-authored skill has, and its
`references/design-patterns.md` has skill-design guidance worth reading before you write the
body. Save mission-specific skills to the mission tier so the whole team can use them; save a
private shortcut to your own path if it's genuinely just for you.

## Reporting platform bugs — GitHub discipline

Your system prompt already covers *when* to file an issue and what a good report looks like. One
addition: always call `ListGithubIssues` first — filing a duplicate wastes the same review
attention a real new bug needs, and the tool exists specifically so you check before you write,
not after.
