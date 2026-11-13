# Code structure — working practice

Moved out of the root `CLAUDE.md`, which keeps the one-line triggers; this is the full text.

Code structure is maintained **continuously during development**, the same as security and operational resilience below. These are the triggers — moments where you pause and reason about file and function boundaries regardless of what feature you're building.

**A file crossing roughly 500 lines** — Does everything in this file share one responsibility (a flat list of independent route handlers, or one genuinely cohesive class), or does it now mix concerns that could be reasoned about separately — routing, persistence, policy, orchestration? If the concerns are separable, extract before adding more to the file.

**A function crossing roughly 80–100 lines** — Can it be read start to finish and verified in one pass, or does it have several sequential phases (parse → connect → wire → launch; or route match → auth → query → respond) that could each be named and tested on their own? Long is not automatically wrong — a flat dispatch with short bodies is fine — but a function with internal phases and shared mutable state threaded across those phases is a decomposition candidate.

**A new module being created already large** — Before writing one undivided file for a family of related things (tools, routes, handlers), look for the closest existing precedent in the repo (e.g. `packages/agent-runtime-worker/src/tools/` — one file per tool). A file born large from day one is harder to justify than one that grew large under deadline pressure.

**A file accreting features sprint after sprint with no refactor checkpoint** — If a file has been touched in most of the last five sprints purely by addition, that is itself a signal, independent of current size. Ask whether the next feature is another such addition or a forcing function to extract a module.

**One operation, one home** — An operation is something the system does for whoever asks it: a person in the cockpit, the control copilot, the mission copilot, an agent, a background job, or the platform on a timer. It is defined by its intent, not by its code path. Its rules — the checks, the effects, what happens when something has gone wrong — live in one function; each entry point (a route, a copilot action or tool, an agent tool, a scheduled task) adds only who may ask and how the result is shown. Two requests with the same intent are one operation even if the code that serves them looks different; two operations that share a mechanism are still two (a scheduled wake-up and an operator's resume both start a machine, and should not share rules). A fix or a guard is added to the operation, and so reaches every caller; find the callers before changing it. This is the application layer of hexagonal or clean architecture, and the use-case model (actors × use cases); "Don't repeat yourself" in its original sense — one authoritative representation of each piece of knowledge — not textual similarity, which is why clone detection never finds it.

Code structure is a judgment call, not a hard gate — a long file made of many small, independent pieces does not need splitting; a short file that already tangles unrelated concerns does. When in doubt, extract.

See `docs/code-structure.md` for the current inventory of oversized files/functions and their decomposition status, and `/code-structure-review` for the periodic audit.
