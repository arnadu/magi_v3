# Documentation coverage checklist

What the documentation should contain, whether or not any document mentions it. The claims
checklist (`doc-claims.py`) checks that what is written is true; this one checks that what
should be written exists. Run it monthly, one area per run if it is long, and say which.

Verdicts: pass · fail · missing · n/a · unverifiable — each with evidence (the document and
section, or where you looked). Work with `checklist.py` (working-agreements).

| Id | Area | Check | Verdict | Evidence |
|---|---|---|---|---|
| DD-01 | Setup | A new developer can go from clone to a running local mission with the user guide alone: prerequisites, setup script, build, start, first message | ? | |
| DD-02 | Setup | Every required environment variable for each process is listed, with where it comes from | ? | |
| DD-03 | Operation | Starting, stopping, suspending, resuming and recovering a mission are each described, for the cockpit and for the command line | ? | |
| DD-04 | Operation | Every operator journey (create, customize, launch, change, schedule, read results, recover, handle an alert) has a how-to | ? | |
| DD-05 | Operation | Troubleshooting covers the failures that actually happened (search the issues and incidents for them) | ? | |
| DD-06 | Reference | Every environment variable in the code is in `docs/env.md` | ? | |
| DD-07 | Reference | Every agent tool and copilot tool is in the spec's tables, with what it does | ? | |
| DD-08 | Reference | Every MongoDB collection is listed with what it holds | ? | |
| DD-09 | Reference | Every platform skill's description matches what it does, and every tool, path and script it names exists | ? | |
| DD-10 | Reference | Every route the cockpit or an agent uses is documented somewhere a developer would look | ? | |
| DD-11 | Decisions | Every significant design choice has an ADR, and every ADR's status (accepted, superseded) is current | ? | |
| DD-12 | Security | Every trust boundary and privileged operation in the code is in the threat model and trust boundaries (flag to appsec; don't judge) | ? | |
| DD-13 | Operations | Every component's failure modes are in the operational-resilience document | ? | |
| DD-14 | Structure | Every file on the structure allowlist has a row in `docs/code-structure.md` with its reason | ? | |
| DD-15 | Status | The roadmap's status and the issues agree: done work marked done, open items findable | ? | |
| DD-16 | Instructions | Each `CLAUDE.md` command runs as written; each rule it states is current | ? | |
| DD-17 | Instructions | Each agent template's prompt names only tools, paths and files that exist | ? | |
| DD-18 | Links | Links between documents resolve (files and anchors) | ? | |
| DD-19 | Examples | Code and command examples in documents still run | ? | |
| DD-20 | Audience | Each document says who it is for, and nothing an operator needs is only in a developer document | ? | |
