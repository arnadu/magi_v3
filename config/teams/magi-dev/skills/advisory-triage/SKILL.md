---
name: advisory-triage
description: Triage dependency advisories since the last baseline — production or development dependency, whether MAGI reaches the vulnerable code, exploitability in MAGI's use — and recommend upgrade, override or accepted risk, in the order the security practice prescribes.
---

# Advisory triage

Supply chain (objective SEC-4). Run weekly, and after any change to `package.json`,
`package-lock.json` or `.nsprc`.

## 1. What is new

```bash
S=$SHARED_DIR/skills/_team/advisory-triage/scripts
python3 $S/audit-diff.py <clone>          # new and resolved advisories since the last baseline
python3 $S/audit-diff.py <clone> --save   # once the triage is written, store this as the new baseline
```

The script runs `npm audit` against the lockfile only (no install needed) and marks each
advisory production or development, direct or transitive, with or without a fix. The first run
has no baseline: everything is new, and the onboarding report covers it.

The repository also has Python components; `pip-audit` is not wired in. Note that gap in the
report rather than installing tools.

## 2. Triage each new advisory

For each, answer in the report:
1. **Where it lives.** Production (ships in the control-plane or mission image) or development
   only (tests, build, tooling)? Direct or transitive, and through which declarer
   (`npm ls <package>` needs an install, so read `package-lock.json`: search for
   `"node_modules/<package>"` and the packages that require it)?
2. **Reachability.** Does MAGI call the vulnerable function, in the vulnerable way? grep the clone
   for the package's import and the API the advisory names. A development-only dependency can
   still matter if CI runs it on untrusted input.
3. **Exploitability in MAGI's use.** Who could supply the malicious input: an agent, a web page,
   the internet, only the developer?
4. **Recommendation**, in the order `docs/security/CLAUDE.md` gives ("the order of remedies"):
   upgrade the direct dependency; else an `overrides` pin, only when the declarer never loads it
   or the fixed line is compatible; else an `.nsprc` entry with notes and an expiry.

Severity of your finding is MAGI's risk, not the advisory's score: a critical advisory in an
unreachable dev-only path may be LOW for MAGI; say why.

## 3. Record

- A finding in the register (`findings-register`) for each advisory that needs action; one
  finding may cover several advisories with the same remedy.
- The report: `YYYY-MM-DD-advisory-triage.md` (`security-reporting`), with a hand-off block
  giving the exact upgrade or override.
- Check `.nsprc`: for each entry, is it past its expiry, or is a fixed release now available?
- KPIs: open HIGH or CRITICAL advisories (production) and days from publication to your report.
- Then save the baseline.
