# Inventory checks

Inventory: YYYY-MM-DD (fill in)

Answer each row for the inventory you wrote, with evidence.
Verdicts: pass · fail · missing · n/a · unverifiable — each with evidence.

| Id | Area | Check | Verdict | Evidence |
|---|---|---|---|---|
| OI-01 | Actors | Every actor was considered: operator (cockpit), control copilot, mission copilot, agents, background jobs, the platform's scheduled work | ? | |
| OI-02 | Sources | The operation list was built from what actors are meant to do (journeys, screens, prompts and skills, tool catalogue, spec), before the code was searched | ? | |
| OI-03 | Intent | Each operation is defined by its intent in one sentence, not by a code path | ? | |
| OI-04 | Evidence | Every entry point in the inventory names the function it reaches (file and name), read in the code | ? | |
| OI-05 | Sameness | For every operation with more than one entry point, the checks, effects and failure behaviour of each are compared, and differences are listed | ? | |
| OI-06 | Failure | Each state-changing operation's behaviour when something has gone wrong is stated for each entry point | ? | |
| OI-07 | Reach | Operations an expected actor cannot reach are listed, with whether that matters | ? | |
| OI-08 | Strays | Entry points met in the code that match no operation are listed | ? | |
| OI-09 | Reads | Figures or statuses the operator sees in more than one place are checked for being computed one way | ? | |
| OI-10 | Coverage | The report says what was inventoried fully, partly, and not at all | ? | |
