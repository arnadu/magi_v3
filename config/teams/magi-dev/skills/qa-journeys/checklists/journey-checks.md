# Journey checks

Journey: J-__ — ________ (fill in)

Answer each row for the journey above, from the code and the instructions as they are now.
Verdicts: pass · fail · missing · n/a · unverifiable — each with evidence.

| Id | Area | Check | Verdict | Evidence |
|---|---|---|---|---|
| QJ-01 | Walk | The steps are written out from the code for each expected actor: screen or tool, route or action, resulting state | ? | |
| QJ-02 | Reach | The operator can complete the journey in the cockpit, every step | ? | |
| QJ-03 | Reach | The control copilot can complete its part with its own tools, every step, without asking the operator to do a step it could do itself | ? | |
| QJ-04 | Reach | The mission copilot can complete its part with its own tools | ? | |
| QJ-05 | Parity | Anything one actor can do here that another expected actor cannot is listed, with whether that gap matters | ? | |
| QJ-06 | Path | The copilots' skills and prompts lead through the shortest safe path the code offers, in the right order | ? | |
| QJ-07 | Order | No step can take effect before its prerequisite (for example a resume before a config change) | ? | |
| QJ-08 | Loop | Every asynchronous step (a card, a job, a schedule, a request to an agent) tells the requester its outcome, and the requester then continues on its own | ? | |
| QJ-09 | Status | At every step the operator can see what is happening and what comes next, in the cockpit or by message, without asking | ? | |
| QJ-10 | Friction | Confirmations, operator messages and minutes needed are counted, and each confirmation is one the safety rules require | ? | |
| QJ-11 | Errors | Invalid input is refused before the operator confirms anything, and the message says what to change | ? | |
| QJ-12 | Errors | A failure at any step is reported to whoever can act, with the cause, and can be recovered without a developer | ? | |
| QJ-13 | Safety | Destructive or costly steps are confirmed, show their consequence (cost, data), and can be undone or stopped | ? | |
| QJ-14 | Test | A test plays the whole journey end to end (name it and its layer), and it runs in CI | ? | |
| QJ-15 | Docs | A how-to for the journey exists and matches what the code does | ? | |
| QJ-16 | Cost | The journey's own cost (LLM calls, machine time) is known and reasonable | ? | |
