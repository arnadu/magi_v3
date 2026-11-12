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

## The security controls checklist: what should exist

`checklists/security-controls.md` lists the controls MAGI should have (authentication, access
control, input and output handling, secrets, logging and monitoring, LLM and agent risks,
supply chain, deployment), drawn from OWASP ASVS, the OWASP LLM Top 10, OWASP's agentic-AI
threats, NIST SSDF and SLSA. Reading code finds controls done wrong; this list finds controls
never built.

- **Weekly**, as part of the in-depth duty: one area of the checklist (rotate through the
  areas; keep the rotation in your mental map), every row with evidence. Each `missing` row is
  a finding with a severity like any other.
- **On a change review**, for each deep commit: which rows does this kind of change touch (a
  new route: SC-05, SC-10, SC-11, SC-26; a new tool for agents: SC-15, SC-30, SC-31, SC-33; a
  new dependency: SC-39)? Check those rows for the change.
- **On a design review**: every row, against the design.

## Checking the security documents against the code

A drift check (task T-06, the weekly drift check, any "is this document current?" question) uses
the same method as the documenter's `doc-consistency` skill: read it. In short:

**The checklist script does the inventory; you do the verdicts.** It is the method, not a hint:

```bash
C=$SHARED_DIR/skills/_team/doc-consistency/scripts/doc-claims.py
python3 $C extract <clone>/<doc>.md [--section "<heading>"] --out <your-report-folder>/claims/YYYY-MM-DD-<doc>.md
#   ...fill in every row: verdict (confirmed / wrong / unverifiable / not-a-claim) and evidence...
python3 $C summary <your-report-folder>/claims/YYYY-MM-DD-<doc>.md   # exits 1 until complete
```

Save the checklist in your own report folder (`reports/docs/claims/` or
`reports/security/claims/`) and paste the `summary` output into the report as its coverage. A
report on a document with no complete checklist is incomplete; say so instead of concluding.

**A check always starts from the document, never from your last report.** "Check", "sweep",
"re-run" or "is this current?" all mean: extract a fresh checklist and verify every row against
the code as it is now. Read your earlier reports only after the checklist is complete, to say
what changed.

1. **Inventory every statement** in the part you check before verifying any, into a working file
   (`$WORKDIR/notes/claims-<doc>-<section>.md`): each status ("open", "fixed", "accepted", "⚠️",
   "✅"), each statement of behaviour ("component X validates Y before use", "Z runs as user
   W"), each value (sizes, ports, limits), each reference (files, findings, ADRs).
2. **Verify each against the code**, behaviour and status first: a status marker is a claim
   about the code today, so read the code it describes; a reference that resolves proves
   nothing about whether the statement around it is still true.
3. **Report coverage**: "N statements: X confirmed, Y wrong, Z unverifiable", per document and
   section. "Consistent with the code" is allowed only with that count.

`working-agreements` applies to every report you write.

## Deployment probes: check a deployed setting before asking

When a document claims something about a **deployed** setting, check it from outside before
asking the user, using only what a deployment exposes publicly (no credential):

| What | How |
|---|---|
| Security headers (CSP mode, HSTS, frame options, ...) | `curl -s -D - -o /dev/null https://<app>.fly.dev/ \| grep -i -E '^(content-security-policy\|strict-transport\|x-frame\|referrer-policy)'` — the CSP header name says the mode: `Content-Security-Policy` is enforcing, `...-Report-Only` is not |
| Liveness | `curl -s https://<app>.fly.dev/healthz` |
| TLS | `curl -sv https://<app>.fly.dev/ -o /dev/null 2>&1 \| grep -E 'SSL connection\|subject:\|expire'` |

The control plane's app name is in `fly.control-<suffix>.toml` (`app = ...`) in your clone.
Record the command and its output in the report. Settings that are not visible from outside
(secrets present, caps, allowlists, the pinned image) can't be checked this way today: say so,
and ask the user once.
