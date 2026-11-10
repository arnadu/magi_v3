---
name: appsec-onboarding
description: The application security architect's first days, or a re-baseline after a long gap — clone, read the security documents and code, write your own system-model notes, import the register, set the supply-chain baseline, and send an onboarding report.
---

# Onboarding (application security)

Task T-01 and the start of T-02 and T-04. Spread it over several turns if needed; record
progress in your mental map's working notes so a later turn can continue.

## 1. Workspace

`bash $SHARED_DIR/skills/_team/repo-workspace/scripts/repo-sync.sh`. If `cursor.py get` says
you have no cursor yet, set it to the initial cursor given in your mental map's mission context;
don't move it further during onboarding.

## 2. Read, in this order

1. The root `CLAUDE.md` and each package's `CLAUDE.md`: what the system is, how it is built,
   the working rules, the security triggers developers are told to watch.
2. `docs/security/CLAUDE.md`, `threat-model.md`, `trust-boundaries.md`, `findings.md`.
3. `docs/practices/`, then the ADR titles in `docs/adr/` (read in full the ones about identity,
   isolation, secrets, scheduling, spend limits, and anything the threat model cites).
4. The house mechanisms themselves (`appsec-foundations`): read `safe-path.ts`, `ssrf.ts`,
   `safe-http.ts`, `safe-git.ts`, the sudo and clean-environment code, the monitor server's
   authentication, the control plane's authentication and pending actions.
5. `scripts/audit/tripwires.sh` and `tripwires.allow`.

## 3. Write your own model

In the **system model notes** section of your mental map, in your own words: the components
and how they talk; the identities and what each can reach; where the secrets are; the
boundaries you consider riskiest and why; anything that surprised you.

Write it from what you read, not from the documents' summaries alone: your value is an
independent view. Where your reading of the code disagrees with a security document, note the
disagreement with file and line; those go in the onboarding report's drift section.

## 4. Register and baseline

- Create `$SHARED_DIR/reports/security/register.md` and import the official tracker's open
  findings and the open `security` issues (`findings-register`, "Importing").
- Supply-chain baseline (`advisory-triage`): run it, triage the critical and high advisories,
  save the baseline.

## 5. Onboarding report

`YYYY-MM-DD-onboarding.md` (`security-reporting`): what you read; your top risks with reasons;
the register import with your assessment of each open finding; the supply-chain baseline;
document drift found; questions for the user. Then PostMessage the user a short pointer, and
mark the onboarding task completed.
