---
name: appsec-foundations
description: Where MAGI's security documents live in the repository, how they relate, the house security patterns to check code against, and what is in and out of scope for the application security role. Read before any security review.
---

# Application security foundations

## Your sources of truth are in the repository, not in this skill

Read them from your own clone (see `repo-workspace`). This skill tells you where to look and how
the pieces fit; it deliberately does not restate their content, because a copy here would go
stale. When a document and the code disagree, **the code is what runs**: the document is stale,
and that is itself something to report.

| Document (path in the clone) | What it is | How you use it |
|---|---|---|
| `docs/security/CLAUDE.md` | The security practice: layers of defence, scanners, how findings are recorded, escalation | How the team works; the escalation table |
| `docs/security/threat-model.md` | Data-flow diagram, trust boundaries (TB-n), STRIDE and OWASP LLM rows per boundary, implementing files per boundary | Map a changed file to its boundary, then check that boundary's rows |
| `docs/security/trust-boundaries.md` | Compact table: each privileged operation, who can write its inputs, and the guard | The quick check: a less-trusted writer with no guard is a finding |
| `docs/security/findings.md` | The official tracker: open, accepted (A-n), fixed (F-n) | Never re-report a tracked finding; check whether a change worsens one |
| `docs/practices/*.md` | Working rules (code quality, structure, resilience, documentation, testing) | The "pause at" triggers for security in the root `CLAUDE.md` come from here |
| `docs/adr/` | Architecture decisions | Why a design is the way it is; an ADR can make something intended |
| `CLAUDE.md` files (root and per package) | Instructions to the coding assistant, including the security triggers | What the developers were told to check |
| `scripts/audit/tripwires.sh`, `tripwires.allow` | Pattern checks run on every push, with the accepted exceptions and their reasons | Don't report what a tripwire already blocks; do check that an allow entry's reason still holds |

## House security patterns

These are the mechanisms MAGI uses for its recurring risks. A change that handles one of these
risks **without** the house mechanism is the first thing to look for. Find each in the clone
(`grep -rn` for the file name) and read it once during onboarding.

| Risk | House mechanism |
|---|---|
| A path built from input (agent, web, user) escapes its root or follows a planted symlink | `safe-path.ts`: resolve inside a root after resolving links, open without following links |
| An outbound HTTP request reaches an internal address (SSRF), including through redirects or DNS | `ssrf.ts` and `safe-http.ts`: every hop vetted, connection pinned to the vetted address |
| A subprocess gets secrets or runs as the wrong identity | Clean environment (only `PATH` and `HOME`), `sudo -u <agent user>` with a fixed command path, only the daemon may invoke sudo |
| git run on an agent-writable workspace executes agent-planted hooks or filters | `safe-git.ts`: hardened environment and arguments, git directory outside the shared folder |
| A MongoDB query built from external input becomes an operator or reaches another mission | Values only, never operators or field names from input; every query scoped by `missionId` |
| Untrusted content (web, documents, other agents) steers an LLM | Content wrapped and labelled as untrusted; but labels are not sanitisers, so the real defence is that no agent holds a secret, caps no agent can raise, and confirmation for external writes |
| An LLM proposes a write outside its sandbox (GitHub, machine lifecycle) | A pending action the operator confirms, re-validated at execution |
| Cockpit renders agent output | Escaping before tags are reintroduced, allow-listed link URLs, sandboxed previews, CSP |
| Tool arguments from the LLM | Checked against the tool's own schema before execution |

The full, current list of guards per operation is `trust-boundaries.md`; use the table above to
know what to grep for, and that file to know where each guard is claimed.

## Scope of this role

**In scope:** threat modelling and trust boundaries; reviewing code and dependency changes for
vulnerabilities; the findings register and the security documents (as proposals); security
requirements for new designs; the **design** of monitoring and audit (what to log, alert rules as
specifications); security sign-off at life-cycle gates.

**Out of scope:** watching for compromise or operating monitoring; responding to live incidents;
production access or actions; writing product code (you propose fixes, others implement them).

**Mono-tenant assumption.** A MAGI installation serves one organization; its users are not
security boundaries from each other. Isolation that matters: agent from agent, agent from daemon,
mission machine from control plane, and everything from the internet. Don't report cross-user
data visibility within one installation as a vulnerability; do report anything that lets an
agent act as the daemon, another agent, or the operator.

**The repository is public.** A vulnerability must never be disclosed in a public place (issue,
discussion, commit message) before it is fixed. See `security-reporting`.
