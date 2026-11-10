---
name: change-review
description: Security review of the commits since your cursor — triage each change by risk, check it against the threat model and the house patterns, flag threat-model drift, judge and search for variants, report, then move the cursor.
---

# Change review (security)

Objective SEC-1: every change to the main branch is security-reviewed promptly. Run on your
schedule (every few hours) or when asked.

## Procedure

1. **Sync and list.** (`repo-workspace`)
   ```bash
   S=$SHARED_DIR/skills/_team/repo-workspace/scripts
   bash $S/repo-sync.sh
   python3 $S/commits-since.py $WORKDIR/repos/<repo> $(python3 $S/cursor.py get) --lens security
   ```
   No commits: update the review-state section of your mental map ("checked at <time>, nothing
   new") and stop; don't write an empty report.

2. **Triage.** For each commit, read the message and the file list. Decide skip, skim or deep
   per file; the script's marks are a starting point. Changes that always get a deep read:
   anything that spawns a process or uses sudo; builds a path from input; makes an outbound HTTP
   call; adds or changes a route, port or socket; touches authentication, sessions, tokens or
   secrets; changes what an LLM can do without confirmation; changes Dockerfiles, CI workflows,
   deployment scripts or dependencies; edits the security documents or the tripwire allowlist.

3. **Map to boundaries.** For each deep file, find its trust boundary in the threat model's
   "implementing files" section (`appsec-foundations`). Then, for that boundary:
   - **mitigated rows**: does the change weaken or bypass the stated mitigation? A change that
     silently invalidates a mitigation is often worse than a new bug;
   - **open rows**: does it make an open finding easier to exploit?
   - **partial rows**: does it close or widen the gap?
   Then check against the house patterns: input reaching a sink without the house mechanism.

4. **New surface.** Anything that doesn't map to an existing boundary (a new external service,
   port, subprocess pattern, environment variable forwarded, identity) is a **threat-model
   delta**: describe the boundary, the suggested rows, and the implementing files, in the
   report's drift section, and queue a refresh of that boundary in your mental map.

5. **Judge.** Each candidate through `security-judgement`: evidence, refutation, severity,
   variants. Check the register and the official tracker for duplicates.

6. **Document drift.** While reading, note any statement in the security documents that the
   reviewed code now contradicts (a mitigation described that no longer exists, a finding marked
   open that the code has fixed, a guard named in the wrong place).

7. **Report** (`security-reporting`): `YYYY-MM-DD-change-review.md` with the range, the depth per
   commit, the verdict, findings, drift and the hand-off block. Update the register.

8. **Move the cursor** to the last commit you fully reviewed:
   `python3 $S/cursor.py set <sha> "change-review <report file>"`. Update the review-state
   section of your mental map and the SEC-1 KPIs (days since the oldest unreviewed commit; share
   reviewed).

## Budget

Matching depth to risk is what keeps this affordable. A batch of documentation-only commits
should cost a few calls; spend the effort on the few commits that touch a boundary. If a range is
too large for one turn, review the riskiest commits first, report, set the cursor only past
what was covered, and continue next turn.
