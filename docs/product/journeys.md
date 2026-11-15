<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Operator journeys

**Draft since 2026-11-14, awaiting the product owner's approval.** The journeys MAGI must support, the actors expected to complete each one, and the operations they use. A journey is verified by walking it for every expected actor: each step reachable, each hand-off reported back, the same result whoever asks. Each journey should have an end-to-end test or scenario that names its id.

| Id | Journey | Actors | Operations | Note |
|---|---|---|---|---|
| J-01 | Sign in, see my missions, sign out | OP | `session.sign-in`, `mission.status`, `session.sign-out` |  |
| J-02 | Create a mission from a request | OP, CC | `platform.catalog`, `mission.create-draft`, `mission.edit-draft`, `mission.launch`, `mission.create` | `mission.create` launches a template at once, without a draft |
| J-03 | Customize a draft before launch | OP, CC | `mission.edit-draft`, `objectives.edit`, `mission.launch` |  |
| J-04 | Change a running mission | OP, CC, MC | `mission.config`, `mission.change-config`, `mission.suspend`, `mission.resume` | `mission.change-config` while it runs; suspend and resume only for a change that needs all activity stopped |
| J-05 | Rename a mission, change its model or cap | OP, CC | `mission.change-config`, `mission.set-spend-cap` |  |
| J-06 | Schedule recurring work | OP, CC, MC, AG | `schedule.create`, `schedule.list`, `schedule.cancel`, `mission.wake` |  |
| J-07 | Read a mission's results | OP, CC, MC | `file.read`, `message.read`, `objectives.progress` |  |
| J-08 | Ask about a mission ("what is X doing?") | OP, CC, MC | `mission.status`, `agent.history`, `message.read`, `objectives.progress` |  |
| J-09 | Give the team new work | OP, MC | `message.send`, `objectives.edit`, `task.create` |  |
| J-10 | Watch and control cost | OP, CC, MC | `mission.spend`, `account.usage`, `mission.set-spend-cap`, `mission.set-ceiling` |  |
| J-11 | Handle an alert or anomaly | OP, CC, MC | `message.send` | And the operation the fix needs |
| J-12 | Recover a mission that won't start or is stuck | OP, CC | `mission.status`, `mission.log`, `mission.repair`, `mission.resume` | `mission.repair` only when the record of the machine or volume is wrong |
| J-13 | Pause or stop a misbehaving agent | OP, MC | `agent.history`, `agent.pause`, `agent.resume`, `job.status`, `job.control`, `mission.suspend` |  |
| J-14 | Give an agent more resources | AG, MC, OP | `machine.upgrade`, `machine.reset-upgrade-allowance` | The operator resets the allowance once the daily cap is spent |
| J-15 | Report a bug or idea about MAGI | OP, CC, MC | `issue.track`, `copilot.propose`, `copilot.confirm` |  |
| J-16 | Upload a file for the agents, download their work | OP | `file.write`, `file.read` |  |
| J-17 | Stop a mission for good | OP, CC | `mission.suspend`, `mission.archive` | `mission.suspend` today; `mission.archive` when built |
| J-18 | Understand why an agent did something | OP, CC, MC | `agent.history`, `message.read`, `file.read`, `mission.log` |  |
| J-19 | Work with my copilot | OP | `copilot.ask`, `copilot.propose`, `copilot.confirm`, `copilot.dismiss`, `copilot.history`, `copilot.settings`, `copilot.limits` |  |
| J-20 | Track progress against objectives | OP, CC, MC | `objectives.progress`, `task.update`, `kpi.record` | CC records the KPIs assessed by judgement; MC updates tasks |
