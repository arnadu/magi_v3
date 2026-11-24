# MAGI's Nuclei templates

Run by `scripts/security/stack/stack.py` against the local stack (environment B); never against a
deployment. Each template states its oracle: a match is a finding.

| Template | Invariant | Looks for |
|---|---|---|
| `magi-cross-tenant` | `sec.tenant-scoped` | Bob's answer for Alice's mission is a 200, or carries her marker |
| `magi-no-credential` | `sec.authenticated` | an operator route that does not answer 401 without a credential |
| `magi-security-headers` | `sec.served-apart` | the cockpit page without a CSP, `nosniff`, a frame refusal or a referrer policy, or naming its framework |
| `magi-exposed-files` | `sec.no-secrets-to-agents` | environment files, git config, manifests or source served |
| `magi-source-maps` | — | the cockpit bundle's source map served |
| `magi-error-leak` | `sec.input-validated` | an error answer with a stack, a path inside the image or a driver error |

`controls/magi-control.yaml` holds the probes aimed where they are allowed; each must match.
Variables passed by the runner: `alice_token`, `bob_token`, `alice_mission`, `alice_marker`.
