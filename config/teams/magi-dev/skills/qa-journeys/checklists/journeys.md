# Operator journeys

The journeys MAGI must support, and which actors are expected to perform them. A reference
list, not a checklist: review one or two journeys per run with `journey-checks.md`. Add a
journey when you find one that is missing here (in your report and your mental map).

Actors: **O** the operator in the cockpit · **CC** the control-plane copilot (on request) ·
**MC** the mission copilot (inside a mission) · **A** an agent.

| Journey | Name | Expected actors | Outline |
|---|---|---|---|
| J-01 | Sign in, see my missions, sign out | O | Google sign-in, missions list with status, sign out |
| J-02 | Create a mission from a request | O, CC | Describe the goal; team designed; draft built; reviewed and edited; launched; first run checked |
| J-03 | Customize a draft before launch | O, CC | Open the draft; change agents, prompts, model, cap, team files, objectives; launch |
| J-04 | Change a running mission | O, CC, MC | Suspend; change agents, prompts or settings; resume; changes take effect |
| J-05 | Rename a mission, change its model or cap | O, CC | The new name, model or cap shows everywhere and takes effect |
| J-06 | Schedule recurring work | O, CC, MC, A | A recurring duty fires on time, reaches the right agent, survives a suspend |
| J-07 | Read a mission's results | O, CC, MC | Find the deliverables (files), the agents' messages, the objectives' progress |
| J-08 | Ask about a mission ("what is X doing?") | O, CC, MC | An accurate answer from the agents' actual state |
| J-09 | Give the team new work | O, MC | A message or task reaches the right agent, which acts on it |
| J-10 | Watch and control cost | O, CC, MC | See spend against cap; raise or lower the cap; a mission stops at its cap; the operator is told |
| J-11 | Handle an alert or anomaly | O, CC, MC | The alert reaches someone who can act; the cause is found; the fix applied; noise does not reach the operator |
| J-12 | Recover a mission that won't start or is stuck | O, CC | Diagnose; fix (resume, fix the volume, raise a limit); confirm it runs |
| J-13 | Pause or stop a misbehaving agent | O, MC | Pause the agent or suspend the mission at once; resume later |
| J-14 | Give an agent more resources | A, MC, O | A temporary upgrade within limits, reverted on time, reported |
| J-15 | Report a bug or idea about MAGI | O, CC, MC | An issue is filed with enough context, after the operator confirms |
| J-16 | Upload a file for the agents, download their work | O | Upload to the shared folder; agents see it; download results |
| J-17 | Retire a mission | O, CC | Suspend it for good; its costs stop; its data stays readable |
