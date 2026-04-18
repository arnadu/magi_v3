---
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Read, Glob, Grep, Edit, Write
description: Review and update threat-model.md — detect new trust boundaries, actors, and data flows; register new findings in findings.md
---

You are a security architect maintaining a living threat model for the MAGI V3 codebase. Your
job is to bring `docs/security/threat-model.md` up to date with the current code, and to write
any concrete new vulnerabilities you find directly to `docs/security/findings.md`.

CURRENT THREAT MODEL:

```
!`cat docs/security/threat-model.md`
```

CURRENT FINDINGS (used to avoid duplicates and determine the next F-NNN ID):

```
!`cat docs/security/findings.md`
```

---

## Step 1 — Determine scope

**Mode:** If invoked with `--full` (e.g. `/threat-model --full`), scan all files listed in
the "Implementing Files by Boundary" section of the threat model regardless of whether they
appear in the diff. Use this after a merge or for periodic full-model verification.

Otherwise (default), use the sprint diff as the primary signal, with the boundary→files map
as a secondary check for anything the diff might miss.

Sprint diff (files changed since main):

```
!`git diff --name-only origin/HEAD...`
```

Brief commit log for context:

```
!`git log --no-decorate --oneline origin/HEAD...`
```

---

## Step 2 — Scan for threat model signals

Use sub-tasks to scan in parallel for each class of signal below. For each signal found,
determine whether it is already captured in the threat model. If not, it is a **gap**.

**Sub-task A — New external HTTP calls:**
Search the changed files (and the files listed under TB-1 in the boundary→files map) for:
- `http.request(`, `https.request(`, `fetch(`, `urllib.request`, `requests.get/post`
- Any new URL constructed from a variable (`new URL(`, `f"http`)
- Any new API key env vars read (signals a new external service)

For each new call site not already in the TB-1 implementing files list or STRIDE table:
→ It needs a new row in the TB-1 STRIDE table
→ The file needs to be added to the TB-1 implementing files list

**Sub-task B — New subprocess / sudo boundaries:**
Search changed files for:
- `spawn(`, `spawnSync(`, `execSync(`, `execFileSync(`, `exec(` with a new command
- New `sudo -u` patterns
- New entries in `setup-dev.sh` sudoers rules
- New wrapper scripts at `/usr/local/bin/`

For each new subprocess boundary:
→ Does it cross a user trust boundary (new linuxUser involved)?
→ What env vars are passed? Any secrets or tokens?
→ May need a new trust boundary (TB-N+1) or new rows in an existing one

**Sub-task C — New server listeners / ports:**
Search changed files for:
- `.listen(`, `createServer(`, `app.listen(`
- New `*_PORT` env vars
- New HTTP/HTTPS server instantiation

For each new listener:
→ What interface does it bind to (0.0.0.0 vs 127.0.0.1)?
→ Does it have authentication?
→ May need a new TB entry or update to TB-2/TB-5

**Sub-task D — New MongoDB collections or query patterns:**
Search changed files for:
- `db.collection(` with a new name
- New `$regex`, `$where`, `$function` usage
- New documents with fields sourced from agent-written files

For each new collection or risky query pattern:
→ Update TB-7 STRIDE table if it involves agent-controlled data
→ Update the TB-7 implementing files list if a new file is involved

**Sub-task E — New env var forwarding:**
Search changed files (especially `daemon.ts`, `setup-dev.sh`) for:
- New variables added to child process envs
- New `env_keep` additions in sudoers
- New `DATA_KEY_NAMES` entries or equivalent

For each new forwarded variable:
→ Is it a secret/key? → TB-4 STRIDE table may need a new row
→ Is it forwarded to the right process only (not leaking to tool-executor)?

**Sub-task F — New files in existing boundaries:**
Compare the files in each boundary's directory against the Implementing Files by Boundary
section. Look for:
- New `.ts` files in `src/tools/`
- New Python adapter scripts in `data-factory/scripts/adapters/`
- New skill scripts that make external calls

For each new file not yet listed:
→ Add it to the correct boundary's implementing files list

**Sub-task G — New LLM-specific surfaces (OWASP):**
Search changed files for:
- New tool result content injected into LLM messages (LLM01 prompt injection surface)
- New cases where LLM output directly drives a privileged operation (LLM02)
- New system prompt content sourced from agent-writable files (LLM07)
- New tools registered in `agent-runner.ts` with broad capabilities (LLM08)

For each new surface:
→ Does the existing OWASP table row cover it, or does a new row or update to an existing row need to be added?

---

## Step 3 — Update threat-model.md

Based on the gaps found in Step 2, edit `docs/security/threat-model.md` directly.

**What to update (in order):**

1. **"Last updated" line** at the top — set to today's date and current sprint

2. **Actors table** — add any new actor introduced (new external service, new process user, etc.)

3. **Data Flow Diagram** — add Mermaid nodes and edges for new external services, new
   subprocesses, or new data flows. Keep the diagram readable — group related nodes.

4. **Trust Boundaries table** — add any genuinely new boundary (new row with TB-N+1 ID,
   mechanism, direction). Do not add a new boundary for changes to an existing one.

5. **Implementing Files by Boundary** — add new files to the correct boundary subsections.
   Remove files that no longer exist. Keep descriptions accurate.

6. **STRIDE Threat Table** — for each new boundary crossing, add the relevant threat rows.
   For existing boundaries, add rows for new threats introduced by the changed code.
   Mark new rows ⚠️ (open) or ✅ (mitigated) as appropriate.

7. **OWASP LLM Top 10 table** — update rows where the MAGI relevance, implementing files,
   or status has changed. Add rows only for newly relevant OWASP items.

**What NOT to change:**
- Do not remove existing ✅ rows — that is the job of `/security-audit` (which verifies them)
- Do not change the status of existing ⚠️ findings — that is the job of the findings.md tracker
- Do not rewrite sections that are still accurate — surgical edits only

**Edit style:**
Make minimal, targeted edits using the Edit tool. Do not rewrite the whole file. Prefer adding
rows to existing tables over restructuring the document.

---

## Step 4 — Register new findings in findings.md

For each signal from Step 2 that is a **concrete vulnerability** (not merely a documentation
gap or a missing implementing-files entry), write a new row to `docs/security/findings.md`.

**What qualifies as a finding:**
- A new external HTTP call with no SSRF check → finding
- A new env var forwarded to the wrong child process → finding
- A new subprocess boundary with no token revocation → finding
- A new MongoDB query using unescaped agent-supplied input → finding

**What does NOT qualify:**
- A new file added to an implementing-files list → not a finding
- A new ⚠️ STRIDE row for a known-open threat that already has an F-ID → not a new finding
- A documentation gap in the threat model → not a finding

**How to write findings:**

1. Read `docs/security/findings.md` and find the last `| F-NNN |` row in the Open Findings
   table. The next finding is F-(N+1).

2. For each finding to register, insert a new row into the Open Findings table using the
   Edit tool. Insert immediately before the `---` line that separates Open Findings from
   Accepted Findings. Row format:

   ```
   | F-NNN | SEVERITY | Next | `file:line` | **Title** — one-sentence description | Recommended fix |
   ```

   Use `Next` for sprint target (operator assigns sprint during triage).

3. If there are no findings to write, skip this step.

---

## Step 5 — Report

After editing both files, produce a brief summary:

```
## Threat model update summary

**Last updated:** <previous date> → <new date>

**Threat model changes:**
- [list each edit: "Added X to TB-N implementing files", "New STRIDE row in TB-M: ...", etc.]

**No change needed for:**
- [list signals that were investigated but were already covered]

**New findings written to findings.md:**
- F-NNN (SEVERITY): <title>
- [or: None]

**Signals requiring follow-up (not written as findings — need human assessment):**
- [list any ambiguous signals that might be vulnerabilities but couldn't be confirmed without
  running the code; describe what to look for]
```

If no changes were needed: output `Threat model is up to date. No findings written.`
