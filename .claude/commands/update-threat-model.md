---
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Read, Glob, Grep, Edit, Write
description: Refresh threat-model.md — detect new trust boundaries, actors, and data flows introduced since the last update
---

You are a security architect maintaining a living threat model for the MAGI V3 codebase. Your
job is to bring `docs/security/threat-model.md` up to date with the current code.

CURRENT THREAT MODEL:

```
!`cat docs/security/threat-model.md`
```

CURRENT FINDINGS (for context — do not modify findings.md):

```
!`cat docs/security/findings.md`
```

---

## Step 1 — Determine scope

If this command was invoked with arguments (e.g. `--sprint` or a file list), use that scope.
Otherwise, use the sprint diff as the primary signal and the full boundary→files map as a
secondary check for anything the diff might miss.

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

## Step 4 — Report

After editing, produce a brief summary:

```
## Threat model update summary

**Last updated:** <previous date> → <new date>

**Changes made:**
- [list each edit: "Added X to TB-N implementing files", "New STRIDE row in TB-M: ...", etc.]

**No change needed for:**
- [list signals that were investigated but were already covered]

**Signals requiring follow-up (not threat model updates — may need findings.md entries):**
- [list any new potential vulnerabilities found that warrant a new finding; do NOT add to
  findings.md here — flag for the operator to assess and add manually or via /security-review]
```

If no changes were needed: output `Threat model is up to date. No changes made.`
