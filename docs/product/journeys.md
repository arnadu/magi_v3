<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Journeys

**Approved 2026-11-19.** The journeys MAGI must support: the operator's (`J-`), with the copilots, and the agents' (`A-`); the actors expected to complete each one, and the operations they use. A journey is verified by walking it for every expected actor: each step reachable, each hand-off reported back, the same result whoever asks. Each journey should have an end-to-end test or scenario that names its id.

| Id | Journey | Actors | Operations | Note |
|---|---|---|---|---|
| J-01 | Sign in, see my missions, sign out | OP | `session.sign-in`, `mission.status`, `session.sign-out` |  |
| J-02 | Launch a mission from a template | OP | `platform.offerings`, `template.browse`, `mission.launch` | Only a unique mission name is asked for (decision 6); `template.browse` when editable templates ship |
| J-21 | Design a template with the control copilot, then launch it | OP, CC | `platform.offerings`, `template.browse`, `template.create`, `template.edit`, `mission.create-draft`, `mission.edit-draft`, `objectives.edit`, `copilot.ask`, `copilot.confirm`, `mission.launch` | Blank, cloned from a template, or from a running mission. Until editable templates ship, a draft stands for the template |
| J-04 | Change a running mission, with the copilots | OP, CC, MC | `mission.read-config`, `mission.change-config`, `mission.set-spend-cap`, `agent.pause`, `agent.resume`, `mission.suspend`, `mission.resume` | `mission.change-config` while it runs; suspend and resume only for a change that needs all activity stopped |
| J-06 | Schedule recurring work | OP, CC, MC, AG | `schedule.create`, `schedule.list`, `schedule.cancel`, `mission.wake` |  |
| J-07 | Browse a mission's files and results, and download them | OP, CC, MC | `file.read`, `file.download`, `message.read`, `objectives.progress` | Where the mission's work is rendered |
| J-08 | Work with the mission copilot to understand what the agents did and decide what to change | OP, MC, CC | `mission.status`, `agent.history`, `message.read`, `file.read`, `mission.log`, `objectives.progress`, `copilot.ask`, `copilot.dismiss` | Then J-04 for the change |
| J-09 | Give the team new work: a message, with files, or a change to the objectives | OP, MC | `message.send`, `file.upload`, `objectives.edit`, `task.create` |  |
| J-10 | Watch and control cost | OP, CC, MC | `spend.report`, `mission.set-spend-cap`, `mission.set-ceiling` |  |
| J-11 | Handle an alert, or recover a mission that is stuck or won't start | OP, CC, MC | `oversight.alert`, `mission.status`, `mission.log`, `mission.repair`, `mission.resume`, `message.send` | `mission.repair` only when the record of the machine or volume is wrong |
| J-13 | Pause or stop a misbehaving agent, or the whole mission | OP, CC, MC | `agent.history`, `agent.pause`, `agent.resume`, `job.status`, `job.control`, `mission.suspend` |  |
| J-14 | Give a mission more resources | AG, MC, OP | `machine.upgrade`, `machine.reset-upgrade-allowance` | An agent asks the mission copilot; the operator resets the allowance once the daily cap is spent |
| J-15 | Report a bug or idea about MAGI | OP, CC, MC | `issue.track`, `copilot.confirm` |  |
| J-16 | Upload a file for the agents | OP | `file.upload`, `file.write`, `message.send` |  |
| J-17 | Stop a mission for good | OP, CC | `mission.suspend`, `mission.archive` | `mission.suspend` today; `mission.archive` when built |
| J-20 | Track progress against objectives | OP, CC, MC | `objectives.progress`, `task.update`, `kpi.record` | CC records the KPIs assessed by judgement; MC updates tasks |
| J-22 | Use a mission's interactive app | OP, MC | `app.status`, `app.open`, `app.control`, `message.send` | Open it from the mission cockpit, or from a copied URL in another tab; ask the team by message to change it |
| A-01 | Act on a message: read it, do the work, answer | AG | `message.read`, `agent.remember`, `file.write`, `message.send`, `task.update` | The loop of every turn; `agent.dispatch`, `agent.turn` and `agent.reflect` run underneath |
| A-02 | Research a question | AG, SUB | `web.search`, `web.fetch`, `web.browse`, `web.research`, `agent.shell`, `file.write`, `message.send` |  |
| A-03 | Produce and publish a deliverable | AG, SUB | `file.write`, `image.create`, `agent.shell`, `message.send`, `task.update`, `kpi.record` | Publishing is writing it to the shared folder and telling its readers |
| A-04 | Run work in the background and use its output | AG, JOB | `job.submit`, `job.run`, `data.query`, `web.search`, `web.fetch`, `message.send`, `agent.shell` | The job tells its author when it ends; the agent reads the output |
| A-05 | Schedule recurring work for itself or its team | AG | `schedule.create`, `schedule.cancel`, `mission.status` | By writing and removing schedule files |
| A-06 | Track its work against the objectives | AG | `task.create`, `task.update`, `kpi.record`, `cost.allocate` |  |
| A-07 | Lead a team: hand out work and follow it up | AG | `message.send`, `message.read`, `task.create`, `task.update`, `mission.status` | For an agent that supervises others |
| A-08 | Ask for more resources | AG, MC | `message.send`, `machine.upgrade` | The agent asks the mission copilot, which decides |
| A-09 | Keep its memory useful | AG | `agent.remember`, `agent.history` | Its mental map and its own past turns |
| A-10 | Publish an interactive app for the operator | AG | `file.write`, `app.declare`, `app.run`, `app.status`, `message.send`, `app.control` | The agent writes the app, declares it, sees it answer, and tells the operator where to find it |
| A-11 | Review a codebase item by item | AG, JOB | `mission.platform-task`, `job.submit`, `job.run`, `agent.investigate`, `file.write`, `message.send` | Planned (security assurance plan, step 6): a platform task keeps a read-only copy of the repository; the agent's job puts each item to a clean-context sub-agent and checks its answer; what survives is filed and the author told |
