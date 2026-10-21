# Documentation consistency matrix — re-check (2026-10-21)

The October 2026 audit (§8 of its review, kept in the gitignored audit kit) listed every place
where a document or comment claimed something the code did not do. This file records where each
of those rows stands after the remediation (Sprint 28f, the code-quality plan, and the #80/#82/#84
work). The M6 gate is "every row ✅ or deleted".

✅ fixed — the doc or the code now agrees · ✅ now — corrected in this pass · A — accepted, with the
reason.

| # | Claim (where) | Verdict | How |
|---|---|---|---|
| 1 | Daemon waits for mail indefinitely after `maxRuns` (operational-resilience) | ✅ now | Code fixed by D1 (no cap for a daemon, exit 1 when the loop ends unasked); the resilience rows now say so |
| 2 | SSRF fixed, F-001 (threat model) | ✅ now | Row describes F-043: every address classified, pinned connection, redirects re-validated, streaming cap |
| 3 | Monitor binds 127.0.0.1:4000, mutating routes unauthenticated (threat model, 3 places) | ✅ now | `[::]:4000`, token on every route incl. GET/SSE (F-042) |
| 4 | Data API keys forwarded to background jobs (CLAUDE.md, daemon.ts, README) | ✅ now | Held by the daemon only; jobs use the `data-*` Tool API proxies (CR-04/F-030) |
| 5 | Cockpit build output is committed (vite.config) | ✅ now | Gitignored, built by CI |
| 6 | UI at `public/cockpit/` (control-plane Dockerfile) | ✅ now | `public/` |
| 7 | WriteFile creates parent directories | ✅ fixed | `execWriteFile` does `mkdir -p` (T1) |
| 8 | Bash timeout up to 600 s | ✅ fixed | T3: the loop honours a tool's own budget and cancels on timeout |
| 9 | 5 platform skills (CLAUDE.md) | ✅ fixed | CLAUDE.md describes the directory rule; the cockpit reads `GET /api/catalog` |
| 10 | "Sprints 1–28e done" beside 28g done (CLAUDE.md) | ✅ now | "Sprints 1–28e and 28g are done" |
| 11 | pm2 process supervision (CLAUDE.md) | ✅ now | Fly restart policy in production, foreground locally |
| 12 | Node 18 pitfalls and polyfill (CLAUDE.md, vitest.setup) | ✅ now | Node ≥ 22.15; polyfill branch and pitfall removed (NP1) |
| 13 | Markdown renderer "can never re-open a tag" (markdown.ts) | ✅ fixed | Quote escaping + URL allow-list (F-049) |
| 14 | Egress proxy "DNS resolved here, once" | ✅ fixed | True since F-043 (pinned connect) |
| 15 | Egress proxy "reachable only by Chromium" | ✅ now | Comment says any local process could use it, harmlessly (it only forwards to public addresses) |
| 16 | Copilot daemon "events will not be missed" | ✅ fixed | Claim removed with CD2 |
| 17 | Tool API exposes FetchUrl … PostMessage | ✅ now | Header lists the `data-*` proxies too |
| 18 | Tool API answers 504 on timeout | ✅ fixed | TA2: the timeout race answers 504 |
| 19 | "Comments never reference tasks/callers" vs ~300 history comments (CLAUDE.md) | A | Bulk rewrite rejected in the plan; tripwire T11 ratchets the count down; one-line incident references stay (they are the "why") |
| 20 | README template list omits templates | ✅ fixed | README no longer lists templates |
| 21 | README "template seeding" script | ✅ now | Scripts line describes the real scripts |
| 22 | Stale line counts (code-structure.md) | ✅ now | Re-measured; a moved count is checked at each `/code-structure-review` |
| 23 | Env vars undocumented (CLAUDE.md) | ✅ fixed | `docs/env.md` generated from the catalog, test-checked (R-8) |
| 24 | `checkPath` not applied (research, team files, RestartBackgroundJob) | ✅ fixed | RS2, TF1, F-045/F-046 |
| 25 | Agents cannot reach daemon secrets | ✅ fixed | GIT1, RS2, TF1 closed |
| 26 | `SearchMissionHistory` returns excerpts | ✅ now | It returned metadata only; now an excerpt around each match (MC5), tested |
| 27 | `_platform`/`_team` skills read-only | ✅ fixed | Tier dirs locked (WM1, F-047) |
| 28 | SPEC §6 tool tables | ✅ now | All three tables generated from the factories and contract-tested |
| 29 | `UpdateMentalMap` tool (SPEC, ADRs) | ✅ fixed / A | Gone from the SPEC; ADRs 0003/0005/0007/0009/0010 keep the name as the record of the decision at the time |
| 30 | `PublishArtifact` tool (SPEC) | ✅ fixed | Removed |
| 31 | "Never recurses into another ZIP" | ✅ fixed | `document-zip.ts` refuses nested archives by content (DOC1) |
| 32 | `llmCallLog` keeps bodies 7 days, usage indefinitely | ✅ now | Bodies 1 day, rows 90 days (LL1); every text says so |
| 33 | `missions.ts` handlers "~80–120 lines each" (code-structure) | ✅ fixed | Router split (R-1) |
| 34 | Per-user copilot isolation | ✅ fixed | Per-user route and directory (X-TENANT3); per-user OS identity deferred to Sprint 29 and documented |
| 35 | Cross-agent private paths are denied (SPEC) | ✅ fixed | Workdirs 0700 + read denial (ISO1) |
| 36 | `/opt/magi-src` unreachable for other agents | ✅ fixed | ISO2; the Dockerfile comment says `dist/` is readable by necessity |
| 37 | Data keys reach jobs through sudo `env_keep` | ✅ fixed | `env_keep` keeps only the Tool API variables |
| 38 | Background jobs receive data keys (data-factory SKILL.md, gold-digest) | ✅ now | Jobs fetch through the `data-*` proxies with their job token |
| 39 | Scheduling skills: "imported on next heartbeat" | ✅ fixed | ADR-0033 §3; live-verified 2026-10-18 |
| 40 | `github-issues` skill works for mission agents | ✅ now | Skill says mission agents ask the mission copilot; no one is asked for a token (SKL8) |
| 41 | Daily job calls `refresh.sh` | ✅ fixed | DF1 |
| 42 | `read-digest.sh <path>` | ✅ fixed | MAF1/TPL4 |
| 43 | "Commit via git-provenance" | ✅ fixed | MAF1 |
| 44 | Objectives updated via skill scripts (`record-kpi`, …) | ✅ now | Prompt and comments name the `RecordKpi`/`UpdateTask` tools |
| 45 | Objectives store is `goals.json`/`*.jsonl` files | ✅ now | Starting mental map, `SetMissionSpendCap`, schema header describe the MongoDB store |
| 46 | SPEC §6 "kept current with the code by process" | ✅ now | Now enforced by contract tests |
| 47 | `bootstrap.sh` idempotent | ✅ fixed | Removes only deploy machines without mounts (BS1) |
| 48 | `--purge-orphans` removes orphans only | ✅ fixed | Never touches attached volumes, mounted machines, or anything young (RECON1) |
| 49 | `FLY_MISSIONS_IMAGE` pinned by deploy-missions.sh | ✅ fixed | CI pins it after every image build (CI1) |
| 50 | `cli-reset` resets all mission data | ✅ fixed | Clears `PER_MISSION_COLLECTIONS` (CLI1) |
| 51 | `MAX_COST_USD` is a spending cap | ✅ fixed | Wired into the CLI (`cli-cap.ts`, CLI2) |
| 52 | `GET /mailbox` returns the last 500 | ✅ fixed | Newest 500, oldest-first (MR1) |
| 53 | `SearchMissionHistory` scans all missions | ✅ now | Mission-scoped index (CR2) and excerpts (MC5) |
| 54 | Copilot has direct MongoDB access, sees all missions (copilot.yaml) | ✅ now | Tools are scoped to the signed-in user; no database credential (TPL3) |
| 55 | Markdown "fixed tag whitelist with scheme-checked links" | ✅ fixed | F-049 |
| 56 | Cockpit knows 6 skills, 13 ship | ✅ fixed | `GET /api/catalog` (SKILLS-DRIFT) |
| 57 | Skills' `scope:` frontmatter | ✅ now | Removed from the five skills; scope comes from the directory |
| 58 | `node-polyfill` for Node < 20 | ✅ now | See 12 |
| 59 | Mission copilot "cannot reach any other mission" (threat model) | ✅ fixed / A | Claim removed; network reach closed by F-042; the shared cluster credential (X-TENANT2) is accepted until Sprint 29 and stated in the threat model |
| 60 | `prompt.ts` "rounded", "fully static"; monitor "7-day retention" | ✅ fixed | Comments corrected (PR1, AS-R1) |

No row is open. Rows 19, 29 and 59 carry an accepted part, with the reason above.
