---
name: security-judgement
description: How to decide whether something is a real finding, how severe it is, and which verdict a review gets. Refute yourself before you report; depth matched to risk; variant search after every confirmed finding.
---

# Security judgement

False positives cost credibility; a team that learns to ignore your reports is worse off than
one with no reviewer. Every finding goes through these steps before it is written down.

## 1. Evidence standard

A finding states a **concrete path**: who controls the input (an agent, a web page, a signed-in
user, the internet), how it reaches the sink (file:line by file:line), and what it achieves
(reads a secret, acts as another identity, writes outside its root, spends without a cap...).

If you can't trace the full path, it is a **hypothesis**: you may still record it, labelled as
such, with what would confirm or refute it. Never present a hypothesis as a finding.

## 2. Refute it yourself

Before reporting, spend real effort trying to prove yourself wrong:
- Is the input really controllable by someone less trusted? (Operator-set environment variables
  and config are trusted; agent-written files in the shared folder are not.)
- Is there a guard upstream you didn't read? Search for callers; read the whole function.
- Is it already in `docs/security/findings.md` (open, accepted with a rationale, or fixed)?
- Is it intended, per an ADR or an accepted finding? Then it is not a finding unless the change
  invalidates the stated rationale.
- Does the deployment make it unreachable (a port not exposed, a code path only in local dev)?
  Say so; it may lower severity rather than remove the finding.

Record what you checked in the finding ("refutation attempted: ...").

## 3. Severity, in MAGI's context

Use the scale of `docs/security/findings.md`:

| Severity | Typical meaning here |
|---|---|
| CRITICAL | An agent or outside party gains the daemon's or control plane's privileges or secrets, or reaches another installation's data |
| HIGH | Acts as another identity, escapes its root, executes code as another user, or defeats a spend or approval control |
| MEDIUM | Needs specific conditions, or a defence-in-depth layer is missing where the next layer is weak |
| LOW | Hardening, or a real issue with small impact |

Mono-tenant: users of one installation are not a boundary (see `appsec-foundations`).
Calibrate over time from the user's feedback; record lessons in your mental map.

## 4. Depth matched to risk

Triage first, then spend effort where the risk is. A change touching sudo, paths from input,
outbound HTTP, authentication, the gateway or the cockpit's rendering gets a line-by-line read
and a look at its callers. A rename or a test-only change gets a glance. Say in the report how
deep you went for each part.

## 5. Variant analysis

After any confirmed finding, search for the same pattern everywhere else (`grep -rn` the clone
for the sink and for siblings of the vulnerable function). A pattern found once is usually
present more than once. Report variants together, under the first finding.

## 6. Verdicts

Every review ends with exactly one verdict:

| Verdict | When |
|---|---|
| **No security impact** | Nothing in scope touches a trust boundary or a house pattern |
| **Approve** | Security-relevant, reviewed, no findings |
| **Approve with conditions** | Findings exist; list the must-fix-before-release ones explicitly |
| **Reject** | A HIGH or CRITICAL finding is open in scope; cite it |

One rule applies from the start: **no open HIGH or CRITICAL finding in scope at release.**
