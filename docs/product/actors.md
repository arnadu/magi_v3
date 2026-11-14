# Actors

**Draft, 2026-11-14.** Who can ask MAGI for something. The last column is how the code is
reached; scans use it to say which actor an entry point serves.

| Id | Actor | Authority | Reaches MAGI through |
|---|---|---|---|
| `OP` | **Operator**: a signed-in user, owner of their missions | Everything on their own missions, within the platform's ceilings; confirms what a copilot proposes | Cockpit → control-plane routes under `/api` (session); the mission's cockpit pages through the proxy to the mission machine |
| `ADM` | **Platform admin**: `CONTROL_API_KEY`, or a user listed in `PLATFORM_ADMIN_USER_IDS` | As `OP` on any mission; spend ceilings above the platform maximum; platform alerts | Same routes, with the admin key or an admin session |
| `CC` | **Control copilot**: the operator's assistant in the cockpit | Reads the operator's missions; any change is a proposal the operator confirms | Copilot tools (reads) and copilot actions (proposals, executed on confirmation) |
| `MC` | **Mission copilot**: supervises one mission from inside it | Configuration, objectives, schedules and spend cap of its own mission, within the ceiling; reports each change to the operator | Mission-copilot tools on the mission machine; the control plane's mission-copilot routes |
| `AG` | **Agent**: a team member of a mission | Its own work: files, messages, tasks, schedules and jobs it authors | Agent tools; files it writes in `shared/` (schedules, jobs) |
| `JOB` | **Background job**: a script an agent submitted, running as that agent | What its author could do, through scoped tools | The Tool API on the mission machine |
| `PLT` | **The platform itself**, on a timer or an event | Deliver what is due, sample resources, raise alerts, recover after a restart | Timers and ticks in the control plane and the daemon |

Not actors: the image sub-agent and the Research sub-agent run inside an agent's tool call, on
that agent's behalf and within its budget.
