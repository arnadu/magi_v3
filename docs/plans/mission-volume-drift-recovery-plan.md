# Plan: copilot tooling for mission volume-drift recovery

Follow-up to the live incident on 2026-09-24 (`meteo-textbook-20260730`, then `test2`, dev
environment — see [issue #62](https://github.com/arnadu/magi_v3/issues/62) for the full incident
writeup). `mission.volumeId` in MongoDB had drifted to an ID that no longer existed on Fly on two
unrelated missions; a resume on the first deleted its healthy machine before discovering the
target volume didn't exist, taking the mission down (no data loss — the real volume was
untouched). Already shipped, ahead of this plan:

- `volumeExists()` (`fly-machines.ts`) and a guard in `missions.ts`'s `/:id/resume` handler that
  refuses to delete the current machine unless the target volume is confirmed first.
- `reconcile-mission-state.mjs`'s report-only mode now flags any mission whose `volumeId` doesn't
  match a real Fly volume.
- Both drifted missions corrected directly in Mongo.

What's still missing, and this plan's actual scope: the control-plane copilot had **no way to see
any of this**. It inferred "the volume is destroyed" from the error text alone — wrong, and it had
no tool to check. This plan closes that gap: give it the same visibility used to diagnose the
incident, a narrowly-scoped way to fix the one case that's safely automatable, and the same
proactive wake-up every other resource-oversight category already gets.

**No new ADR.** This extends three already-designed subsystems (`GetMissionStatus`, `ProposeAction`,
`AnomalyRecorder`/`AnomalyCategory`) along their existing patterns — no new subsystem, no new trust
boundary. Matches the precedent of F-025 (spend-cap ceiling): a significant design decision
embedded in a bug-fix-driven change, documented here and in code comments rather than a separate
ADR.

## Steps

One commit per step, tests + docs in the same commit, matching the ADR-0031/0032 sprint's own
convention.

| # | Step | Files | Notes |
|---|---|---|---|
| 1 | **`resume-failure` anomaly category.** Add to `AnomalyCategory` (`anomaly.ts`); raise it (hard) from `missions.ts`'s `/:id/resume` catch block via `createMongoAnomalyRecorderForMission`, for *any* resume failure, not just volume-not-found — this also covers failure modes not yet seen. Wakes the copilot the same way `resize-failure` already does. | `anomaly.ts`, `missions.ts` | Unit test: resume failure raises the anomaly with the right severity/message; a mission with no `userId` (shouldn't happen, but don't crash) is handled |
| 2 | **`GetMissionStatus` volume-verification line.** Same shape as the disk-sample line added earlier this sprint: call `volumeExists()`, report `volume: verified on Fly` / `volume: NOT FOUND on Fly`. | `copilot-tools.ts` | Integration test (real Mongo, mocked/real Fly per existing convention for this file) covering both cases |
| 3 | **`fix_mission_volume` ProposeAction type.** Payload is `{missionId}` only — the LLM never supplies a volume ID. Server-side (`copilot-router.ts`'s `executeAction`) searches Fly's volume list for one named `flyVolumeName(missionId)` not referenced by any *other* active mission; refuses (clear error, no silent guess) if that's ambiguous or empty. Writes only `mission.volumeId` in Mongo — never touches Fly. The copilot follows up with the already-existing `resume_mission` action as a separate step. Only meaningful when `mission.status === "error"`, but not hard-restricted to it (a no-op-safe search either way). | `copilot-router.ts`, `packages/control-plane/src/copilot-tools.ts` (tool description) | Unit tests: unique candidate found and applied; ambiguous (two candidates) refuses; none found refuses; a candidate already attached to *another* active mission is excluded |
| 4 | **`mission-recovery` skill: new failure-mode entry.** Same format as the existing `resize-failure` entry (added this sprint): signature (`resume-failure` anomaly, or `errorMessage` containing "volume not found"), what it means, recovery sequence (`GetMissionStatus` → confirm volume missing → propose `fix_mission_volume` → propose `resume_mission`), escalation (no unique candidate → operator, with `flyctl volumes list` as the manual path). | `config/teams/copilot/skills/mission-recovery/SKILL.md` | Structural check only (frontmatter valid) — wording is content review, per this project's testing approach |
| 5 | **`incident-triage` pointer section.** Same dual-audience shape as the ADR-0032 categories: brief section naming `mission-recovery` for the control-plane copilot, and what a mission copilot (if it ever sees this — unlikely, since `/resume` is an operator/copilot-driven route, not something a mission's own copilot calls) would do with its own tools. | `packages/skills/incident-triage/SKILL.md` | Structural check only |
| 6 | **Close-out.** `docs/operational-resilience.md`'s gap row updated (copilot now has the tooling); `MAGI_V3_SPEC.md`'s Tier B tool table and anomaly-category list updated; full regression (`npm run lint && npm test`); live check on dev if a suitable throwaway broken mission exists, otherwise a clearly-flagged "not live-verified" note (matching this project's own honesty convention around live checks). | `docs/operational-resilience.md`, `MAGI_V3_SPEC.md` | — |

## Design notes

- **Why the action can't take a `volumeId` parameter directly:** letting the LLM supply an
  arbitrary volume ID would let a compromised or confused copilot attach any mission's volume to
  any other mission — a real cross-tenant risk. Deriving the candidate server-side from the
  existing naming convention, and refusing on ambiguity, keeps this to "fix the one case we can
  verify," matching the same "server computes it, LLM never supplies the sensitive value" pattern
  `resource-upgrade-tool.ts` already uses for `missionId` itself.
- **Why two actions (`fix_mission_volume` then `resume_mission`) instead of one compound action:**
  smaller, independently-reviewable blast radius. A Mongo field correction is trivially reversible;
  a resume is not (it restarts the mission). Keeping them separate also means an operator declining
  the resume proposal still leaves the (harmless) volume-ID fix in place.
- **Root cause of the drift itself is still open** (issue #62) — this plan is about limiting
  the damage and speeding recovery next time, not preventing the drift from happening at all.
