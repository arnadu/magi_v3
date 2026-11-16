# Inventory checks

Inventory: YYYY-MM-DD (fill in)

Answer each row for the inventory you wrote, with evidence.
Verdicts: pass · fail · missing · n/a · unverifiable — each with evidence.

| Id | Area | Check | Verdict | Evidence |
|---|---|---|---|---|
| OI-01 | Actors | Every actor was considered: operator (cockpit), control copilot, mission copilot, agents, background jobs, the platform's scheduled work | ? | |
| OI-02 | Sources | The comparison starts from the catalog (`docs/product/operations.md`) and the scan (`analysis/operations.md`), at the commit the report names | ? | |
| OI-03 | Scan | Every scan row the report uses was confirmed in the code, and its finding key is cited | ? | |
| OI-04 | Evidence | Every entry point in the inventory names the function it reaches (file and name), read in the code | ? | |
| OI-05 | Sameness | For every operation with more than one entry point, the checks, effects and failure behaviour of each are compared, and differences are listed | ? | |
| OI-06 | Failure | Each state-changing operation's behaviour when something has gone wrong is stated for each entry point | ? | |
| OI-07 | Reach | Operations an expected actor cannot reach are listed, with whether that matters | ? | |
| OI-08 | Catalog | Intents the code serves that no operation describes, and catalog rules or actors that look wrong, are listed as questions for the user | ? | |
| OI-09 | Reads | Figures or statuses the operator sees in more than one place are checked for being computed one way | ? | |
| OI-10 | Coverage | The report says what was inventoried fully, partly, and not at all | ? | |
