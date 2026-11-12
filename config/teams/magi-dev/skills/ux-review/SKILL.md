---
name: ux-review
description: Usability review of the cockpit and of the copilots' conversations with the operator, against a concrete heuristic checklist (Nielsen's ten heuristics made specific to MAGI, plus cost, trust and notification checks), with findings the developers can act on.
---

# Usability review

Two surfaces: the **cockpit** (what the operator sees and clicks) and the **copilots'
conversations** (what they say, ask and propose). Both are judged with the checklist in
`checklists/ux-heuristics.md` (`$SHARED_DIR/skills/_team/ux-review/checklists/`), worked
through with `checklist.py` (`working-agreements`), one surface or one journey per run.

## Sources

- **Cockpit**: its source, `packages/cockpit/src/` (screens are `*.tsx`; what a screen shows,
  which buttons exist, what happens after a click, which errors are displayed). Walk a journey
  (`qa-journeys`) screen by screen.
- **Copilot conversations**: you cannot read other missions' data. Use what the operator
  places in `$SHARED_DIR/qa/transcripts/` (exported chats), and read what shapes the copilots'
  behaviour: their prompts (`config/teams/copilot.yaml`,
  `packages/agent-runtime-worker/prompts/mission-copilot.md`), skills, tool descriptions and
  the action cards' labels (`packages/control-plane/src/copilot-actions.ts`). If no transcript
  is available, say so in the report and ask the operator for one.

## For each finding

Name the heuristic (UX-nn), the screen or the conversation turn, what the operator experiences,
why it matters (time lost, a wrong action made easy, confusion, cost), and a concrete change.
Order findings by how much they hurt in a real journey; a new operator's first mission counts
most.

## Report

`$SHARED_DIR/reports/qa/YYYY-MM-DD-ux-<surface>.md`: scope (surface, journey, transcripts
used), the checklist summary, findings, and a hand-off block for the developers' coding
assistant. You propose; you don't change anything.
