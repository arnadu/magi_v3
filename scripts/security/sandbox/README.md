# The attack sandbox

The shipped mission image, started as production starts it (`FLY_APP_NAME` set, so the firewall is
on and the monitor token required; a MongoDB container instead of Atlas; no model key that works),
and attacked from inside as its agent users. Security assurance plan, step 4.

```bash
python3 scripts/security/sandbox/sandbox.py --image <image> --verbose [--keep]
```

Each cell pairs an attack with a control: the same probe aimed where it is allowed, which must
succeed. A cell is `held` only when the attack failed and the control worked; `unproven` when the
control failed (the probe could not have seen success); `BROKEN` when the attack worked.

| Cell | Invariant | Attack | Control |
|---|---|---|---|
| OS-1 | `sec.least-privilege` | alice reads bob's private file | bob reads it |
| OS-2 | `sec.least-privilege` | alice writes into bob's workdir | bob writes there |
| OS-3 | `sec.no-secrets-to-agents` | alice reads the daemon's environment | the daemon's user reads it |
| OS-4 | `sec.least-privilege` | alice lists the daemon's private job state | the daemon's user lists it |
| SUDO-1 | `sec.least-privilege` | alice sudoes to root, to bob, to `magi-net` | the daemon sudoes to alice's helper |
| JOB-1 | `sec.least-privilege` | alice submits a job claiming to be bob | alice's honest job runs as alice |
| JOB-2 | `sec.contained-paths` | a job request planted as a symlink | the plant is written |
| MON-1 | `sec.authenticated` | every monitor route without the token (from `docs/api/monitor.openapi.json`) | `/status` with the token |
| MON-2 | `sec.contained-paths` | bob's file through the monitor, by traversal and by a symlink in `shared/` | a plain shared file |
| TOOL-1 | `sec.authenticated` | the Tool API without a job token | — |
| NET-1 | `sec.served-apart` | another machine reaches a server an agent bound to all interfaces | it answers inside; port 4000 answers from outside |
| JOB-3 | `sec.contained-paths` | a job request planted as a hard link | the plant has two links |
| SCHED-1 | `sec.least-privilege` | alice writes a schedule that runs a job as bob | alice's own schedule is stored |
| TOOL-2 | `sec.least-privilege` | bob reads a running job's Tool API token from alice's process | alice reads it |
| TOOL-3 | `sec.authenticated` | the job's token used after the job exited | it is accepted while the job runs |
| ENV-1 | `sec.no-secrets-to-agents` | a platform secret in a background job's environment | the job's own token is there |
| ENV-2 | `sec.no-secrets-to-agents` | secrets in the daemon's environment passed through `magi-node`, `magi-job`, `magi-app` | each wrapper's allowed variable passes |
| APP-1 | `sec.served-apart` | bob reaches alice's app on loopback | alice and the daemon reach it |
| HELPER-1 | `sec.least-privilege` | `magi-net` given ports, uids or extra words it must refuse | a valid `allow` |
| HELPER-2 | `sec.least-privilege` | `magi-node`, `magi-job`, `magi-app` run as root | as alice |
| PLAT-1 | `sec.least-privilege` | alice writes the reference copy a platform task keeps (files, mirror, status, the `current` link, the folder) | the copy is readable and the daemon's run wrote its commit |
| PLAT-2 | `sec.least-privilege` | alice runs `magi-task`, through sudo or directly | the daemon reaches the wrapper |
| PLAT-3 | `sec.input-validated` | `magi-task` given a kind, URL, branch or name it must refuse (12 cases), leaving nothing behind | a valid `git-mirror` run returns a commit |
| PLAT-4 | `sec.least-privilege` | the platform user writes alice's workdir or `shared/`, sudoes, or is in `magi-shared` | it writes its own folder |

In CI (`build-execution-image.yml`) it runs on the image just built, before the push, as a gate
(since 2026-11-24, after a clean run): an image where a cell does not hold is not pushed. The log and the summary carry counts only: the repository is public, and a cell that did
not hold is an unfixed vulnerability. The cells that did not hold go to code scanning (maintainers
only) as SARIF.
