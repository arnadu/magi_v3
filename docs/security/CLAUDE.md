# Security Practice — Developer Guide

This document describes how to maintain and use the MAGI V3 security practice. It is the
authoritative reference for everything security-related in the codebase.

---

## Three-layer approach

| Layer | What it catches | When to run |
|-------|----------------|-------------|
| **Automated SAST** (`npm run security`) | Dangerous code patterns, exposed secrets, dependency CVEs | On every PR; `security:sast` and `security:secrets` run as pre-commit hooks |
| **AI review** (`/security-review`) | Business logic flaws, novel attack vectors, architectural weaknesses | Before each sprint completion; on any new external integration or sudo rule |
| **Threat model** (`docs/security/threat-model.md`) | Living DFD + STRIDE — drives what the automated tools check for | Update whenever a new trust boundary, external service, or privilege level is added |

Linting (`npm run lint`) is separate — it covers code quality and style. Security scanning is
complementary; Biome will not find SSRF or MongoDB injection.

---

## Running automated security checks

One-stop command:
```bash
npm run security
```

Individual checks:
```bash
npm run security:sast      # semgrep: dangerous patterns in packages/
npm run security:secrets   # gitleaks: secrets in files and staged changes
npm run security:deps      # npm audit + pip-audit
```

### Tool installation (one-time)

```bash
pip install semgrep           # or: brew install semgrep
brew install gitleaks         # or: download from github.com/gitleaks/gitleaks/releases
pip install pip-audit         # Python dependency scanner
pip install pre-commit        # pre-commit hook framework
pre-commit install            # activate hooks in this repo (run from project root)
```

After `pre-commit install`, gitleaks and semgrep run automatically before each commit.

---

## Running the AI security review

```
/security-review
```

Run this command in Claude Code. It reads the threat model and findings tracker first, then
reviews only the files changed since `main`, then filters false positives. Typical cost:
15–35k tokens (versus 100k+ for a full-codebase scan).

**When to run:**
- Before closing every sprint
- When adding a new external HTTP call, a new `sudo` rule, or a new MongoDB query
- When semgrep flags something and you want to assess blast radius
- When a new bearer token or env var forwarding pattern is introduced

The sprint row in `CLAUDE.md` should record `security-review: run` or `security-review: skipped`.

---

## Updating the threat model

`docs/security/threat-model.md` contains the DFD and STRIDE table. Update it when:
- A new external service is integrated (new HTTP call, new API key)
- A new privilege boundary is introduced (new `sudo` rule, new process user)
- A new IPC mechanism is added (new port, new socket, new shared directory)
- An existing mechanism is significantly changed

Keep the Mermaid diagram in sync with the code. The STRIDE table should have a row for every
trust boundary crossing in the DFD.

---

## Adding a finding

Add a row to the **Open Findings** table in `docs/security/findings.md`:

```
| ID | Sprint | Severity | File:Line | Description | Recommended Fix | Status |
```

IDs are sequential integers (next after the last entry). Severity: `CRITICAL` / `HIGH` /
`MEDIUM` / `LOW`. Status: `OPEN` / `FIXED` / `ACCEPTED` / `DEFERRED`.

When fixing a finding, move it to the **Fixed Findings** table with the sprint in which it
was fixed and a one-line description of the fix applied.

When accepting a finding as a design trade-off (e.g. sharedDir shared write surface),
move it to the **Accepted Findings** table with a rationale.

---

## Escalation criteria

| Condition | Action |
|-----------|--------|
| CRITICAL or HIGH finding in sprint diff | Block sprint completion; fix before merging |
| MEDIUM finding | Add to sprint 13+ backlog; do not block if workaround exists |
| LOW finding | Log in findings.md; prioritise before production deployment |
| Finding touches a trust boundary not in the threat model | Update threat model first |
| Dependency CVE with CVSS ≥ 7.0 | Treat as HIGH; update or pin within current sprint |
