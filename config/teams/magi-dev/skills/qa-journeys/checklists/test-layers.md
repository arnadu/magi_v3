# Test layers checklist

What kinds of tests exist, and whether they run. Verdicts: pass · fail · missing · n/a ·
unverifiable — each with evidence (file names, counts, the CI job).

| Id | Area | Check | Verdict | Evidence |
|---|---|---|---|---|
| TL-01 | Unit | Each package has unit tests, and CI runs them on every push | ? | |
| TL-02 | Integration | Integration tests exist for routes and persistence, and CI runs them (or a schedule does) | ? | |
| TL-03 | Integration | Integration tests use a database of their own, not the shared dev data | ? | |
| TL-04 | Agents | The agent runtime is tested with a real model: loop, multi-agent, tools, limits | ? | |
| TL-05 | Copilots | The control copilot is tested on multi-step workflows with a real model, including confirming its cards | ? | |
| TL-06 | Copilots | The mission copilot is tested with a real model | ? | |
| TL-07 | Seams | Workflows are tested with a scripted model (tool reachable, proposal checked, outcome reported, order safe) | ? | |
| TL-08 | Journeys | Operator journeys are tested end to end (count journeys in `journeys.md` with such a test) | ? | |
| TL-09 | UI | The cockpit is tested in a browser for its main screens | ? | |
| TL-10 | Deployment | Machine lifecycle (launch, suspend, resume, upgrade) is tested, or has a documented manual check run at each release | ? | |
| TL-11 | Regression | Every bug fixed in the last 90 days has a test that fails without the fix | ? | |
| TL-12 | Agents | The MAGI DEV agents and the copilots have known-answer tests with scores tracked over time | ? | |
| TL-13 | Health | Flaky tests are tracked and fixed, not retried silently | ? | |
| TL-14 | Coverage | Coverage floors exist per package and for the risk files, and only go up | ? | |
