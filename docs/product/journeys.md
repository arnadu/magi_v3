# Operator journeys

**Draft, 2026-11-14.** The journeys MAGI must support, the actors expected to complete each
one, and the operations they use. A journey is verified by walking it for every expected actor:
each step reachable, each hand-off reported back, the same result whoever asks. Each journey
should have an end-to-end test or scenario that names its id.

This list replaces the copy in the qa-lead's skill (`qa-journeys/checklists/journeys.md`),
which will point here from the next template update.

| Id | Journey | Actors | Operations |
|---|---|---|---|
| J-01 | Sign in, see my missions, sign out | OP | `session.*`, `mission.status` |
| J-02 | Create a mission from a request | OP, CC | `mission.create-draft`, `mission.edit-draft`, `mission.launch` |
| J-03 | Customize a draft before launch | OP, CC | `mission.edit-draft`, `objectives.edit`, `mission.launch` |
| J-04 | Change a running mission | OP, CC, MC | `mission.change-config` (while it runs); `mission.suspend` and `mission.resume` only for a change that needs all activity stopped |
| J-05 | Rename a mission, change its model or cap | OP, CC | `mission.change-config`, `mission.set-spend-cap` |
| J-06 | Schedule recurring work | OP, CC, MC, AG | `schedule.create`, `schedule.cancel`, `mission.wake` |
| J-07 | Read a mission's results | OP, CC, MC | `mission.results` |
| J-08 | Ask about a mission ("what is X doing?") | OP, CC, MC | `mission.status`, `mission.results` |
| J-09 | Give the team new work | OP, MC | `message.send`, `objectives.edit` |
| J-10 | Watch and control cost | OP, CC, MC | `mission.spend`, `mission.set-spend-cap`, `mission.set-ceiling` |
| J-11 | Handle an alert or anomaly | OP, CC, MC | `message.send`, and the operation the fix needs |
| J-12 | Recover a mission that won't start or is stuck | OP, CC | `mission.status`, `mission.resume` |
| J-13 | Pause or stop a misbehaving agent | OP, MC | `agent.pause`, `agent.resume`, `mission.suspend` |
| J-14 | Give an agent more resources | AG, MC, OP | `machine.upgrade` |
| J-15 | Report a bug or idea about MAGI | OP, CC, MC | `issue.file`, `copilot.confirm` |
| J-16 | Upload a file for the agents, download their work | OP | `file.write`, `mission.results` |
| J-17 | Stop a mission for good | OP, CC | `mission.suspend` today; `mission.archive` when built |
