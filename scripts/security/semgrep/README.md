# MAGI's own Semgrep rules

One rule per `<id>.yml`, with its planted cases in `<id>.ts` (`// ruleid:` must match, `// ok:`
must not). CI runs each rule's test before the scan (`quality.yml`, job `semgrep`), so a rule
that stops matching fails the build rather than going quiet. Locally:

```bash
for r in scripts/security/semgrep/*.yml; do semgrep --test --config "$r" "${r%.yml}.ts"; done
semgrep scan --config scripts/security/semgrep/ packages/
```

| Rule | Invariant | What it catches |
|---|---|---|
| `magi-sudo-helper` | `sec.least-privilege` | `sudo` running anything but a fixed root-owned `magi-*` helper |
| `magi-sudo-in-shell-string` | `sec.least-privilege` | `sudo` inside a shell command string |
| `magi-path-from-request` | `sec.contained-paths` | Request input reaching a filesystem call without the safe-path helpers |
| `magi-mongo-filter-from-body` | `sec.input-validated` | A request-body value reaching a MongoDB filter unvalidated (operator injection) |

A data-flow rule cannot follow a type guard: a guard the code relies on is added as a
sanitizer, with an `// ok:` case, never silenced with `nosemgrep` at the call site.
