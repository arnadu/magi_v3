# Operator journeys: outlines

The journeys MAGI must support (their ids, expected actors and operations) are in the
repository's baseline catalog, `docs/product/journeys.md`; when the two disagree, the catalog is
the intended one and the difference is a question for the user. This file keeps the outline of
each journey's steps, for walking it. Review one or two journeys per run with
`journey-checks.md`. A journey you find missing from the catalog goes in your report as a
question for the user.

Actors: **O** the operator in the cockpit · **CC** the control-plane copilot (on request) ·
**MC** the mission copilot (inside a mission) · **A** an agent.

| Journey | Name | Expected actors | Outline |
|---|---|---|---|
| J-01 | Sign in, see my missions, sign out | O | Google sign-in, missions list with status, sign out |
| J-02 | Launch a mission from a template | O | Browse the templates and what each holds; launch one with only a mission name; it runs |
| J-03 | Design a template with the control copilot, then launch it | O, CC | Describe the goal; a template (today a draft) is made blank, cloned or from a mission; the copilot and the operator edit it; launched; first run checked |
| J-04 | Change a running mission, with the copilots | O, CC, MC | Change agents, prompts, model, cap or settings while it runs; only an agent whose mental map changes is paused; changes take effect and the operator is told |
| J-06 | Schedule recurring work | O (through CC), CC, MC, A | A recurring duty fires on time, reaches the right agent, survives a suspend |
| J-07 | Browse a mission's files and results, and download them | O, CC, MC | Find the deliverables, rendered; the agents' messages; the objectives' progress; download |
| J-08 | Work with the mission copilot to understand what the agents did | O, MC, CC | An accurate account from the agents' actual history; what to change, then J-04 |
| J-09 | Give the team new work | O, MC | A message, with files attached, or a change to the objectives reaches the right agent, which acts on it |
| J-10 | Watch and control cost | O, CC, MC | See spend for a mission or all of them, the same figure everywhere; raise or lower the cap; a mission stops at its cap; the operator is told |
| J-11 | Handle an alert, or recover a stuck mission | O, CC, MC | The alert reaches someone who can act; diagnose; fix (resume, fix the volume, raise a limit); confirm it runs |
| J-13 | Pause or stop a misbehaving agent, or the whole mission | O, CC, MC | Pause the agent or suspend the mission at once; resume later |
| J-14 | Give a mission more resources | A, MC, O | A temporary upgrade within limits, reverted on time, reported |
| J-15 | Report a bug or idea about MAGI | O, CC, MC | An issue is filed with enough context, after the operator confirms |
| J-16 | Upload a file for the agents | O | Upload to the shared folder; agents see it |
| J-17 | Stop a mission for good | O, CC | Suspend it for good; its costs stop; its data stays readable |

The agents' own journeys (`A-01` to `A-09` in the catalog) are walked by an agent, not the
operator; review them from the agents' transcripts.
