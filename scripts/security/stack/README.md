# The local stack (environment B)

The control plane's own image, started on a Docker network created with `--internal` (no route
out: the dummy Fly token and the scheduler's timers reach nothing), with a MongoDB container and
two test tenants, scanned by Nuclei from a container on the same network. Security assurance plan,
step 5. Nothing deployed is touched: dynamic scanning happens here, never against Fly.

```bash
npm run build -w @magi/cockpit
docker build -f packages/control-plane/Dockerfile -t magi-control-local:stack .
python3 scripts/security/stack/stack.py --image magi-control-local:stack --selftest
python3 scripts/security/stack/stack.py --image magi-control-local:stack --verbose [--only magi|community|dast] [--keep]
```

The tenants sign in through `AUTH_TEST_USERS` (`packages/control-plane/src/auth-test-users.ts`):
tokens generated for each run, user ids `test-alice` and `test-bob`, never admins. The control plane
refuses to start with that variable when `FLY_APP_NAME` is set. Alice creates a draft mission whose
name is a random marker; Bob's requests for it must neither succeed nor carry the marker.

| Run | Templates | Verdict |
|---|---|---|
| controls | `scripts/security/nuclei/controls/` | each must match (the stack is up, Alice reads her own mission, Bob is signed in, the page is the cockpit), or the run is unproven |
| magi | `scripts/security/nuclei/templates/` | a match is a finding; a gate (exit 1) |
| community | nuclei-templates, pinned release and checksum, signatures enforced (`-dut`): exposures, misconfiguration, CVEs and vulnerabilities of low and above, without `dos` or `intrusive` | report-only until a baseline is triaged |
| dast | Nuclei's DAST templates over every route of `docs/api/control-plane.openapi.json`, as Alice on her own mission | report-only until a baseline is triaged |

`--selftest` replaces the control plane with a planted server that leaks everything our templates
look for; each template must match it, or it is blind.

Nightly in CI (`.github/workflows/security-nightly.yml`). The log and the summary carry counts
only (the repository is public); the findings go to code scanning as SARIF (maintainers only).
