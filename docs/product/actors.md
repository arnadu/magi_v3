<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Actors

**Approved 2026-11-19.** Who can ask MAGI for something. The last column is how the code is reached; scans use it to say which actor an entry point serves. Other baselines: [README](README.md).

| Id | Actor | Authority | Reaches MAGI through |
|---|---|---|---|
| `OP` | Operator: a signed-in user, owner of their missions | Everything on their own missions, within the platform's ceilings; confirms what a copilot proposes. A platform admin (`CONTROL_API_KEY`, or a user in `PLATFORM_ADMIN_USER_IDS`) is an operator with wider authority, written as rules ("ADM: …"): any mission, ceilings above the platform maximum, platform alerts | Cockpit → control-plane routes under `/api` (session or admin key); the mission's cockpit pages through the proxy to the mission machine |
| `CC` | Control copilot: the operator's assistant in the cockpit, an agent with privileged access that runs on the control plane | Reads the operator's missions; any change is a proposal the operator confirms; receives the platform's reports and alerts | Copilot tools (reads) and copilot actions (proposals, executed on confirmation); a shell in its own folder |
| `MC` | Mission copilot: an agent with privileged access that supervises one mission from inside it | Configuration, objectives, schedules and spend cap of its own mission, within the ceiling; reports each change to the operator; receives the reports and alerts about its mission | Mission-copilot tools on the mission machine, on top of every agent tool; the control plane's mission-copilot routes |
| `AG` | Agent: a team member of a mission | Its own work: files, messages, tasks, schedules and jobs it authors | Agent tools; files it writes in `shared/` (schedules, jobs) |
| `SUB` | Sub-agent: a model loop an agent's tool starts (the Research loop, CreateImage's image agent) | Acts with the calling agent's identity and budget, through a narrower set of tools; the agent sees only its answer | The tools its loop is given: Research's SearchWeb, FetchUrl, BrowseWeb and Bash; the image agent's own tools |
| `JOB` | Background job: a script an agent submitted, running as that agent | What its author could do, through scoped tools | The Tool API on the mission machine |
| `PLT` | The platform itself, on a timer or an event | Deliver what is due, sample resources, raise alerts, recover after a restart | Timers and ticks in the control plane and the daemon |

Copilots are agents with privileged access: what they share with every agent is the agent's operation, and what they may do beyond it is a rule. A sub-agent is an actor of its own because it decides for itself, reads untrusted content far more than its agent, and the catalog must say which operations it may reach.
