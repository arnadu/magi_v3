# ADR-0022 — Control-plane vs. mission-plane config editing scope

**Status**: Accepted, amended
**Sprint**: 26c
**Date**: 2026-07-26

---

## Context

While manually verifying ADR-0021's structured-config migration, `packages/control-plane/public/index.html`'s config editor (suspend a mission → edit → save) corrupted a live mission's config: saving after changing only the mission-level model dropdown produced a server-side validation error, `agents.1.supervisor: Required` / `agents.1.systemPrompt: Required` — the second agent's two most important fields silently vanished on save.

Isolating the failure with the mission's real data (two agents, ~6,000-character hand-tuned system prompts) reproduced no bug in the YAML conversion logic itself outside a live browser — pointing at something specific to that environment, not a fixable one-line defect. That miss was the trigger to look at what the editor actually does rather than patch around it:

- It round-trips **large free-text fields** (`systemPrompt`, `initialMentalMap`, skill/prompt file contents) through DOM `<textarea>` → client-side `jsyaml.dump()`/`.load()` → server YAML-shaped parse → Zod validation, with a hand-rolled block-splitting regex (`parseYamlBlocks`) stitching multi-line scalar content back together in between. Every hop is a place a large, structurally significant string can be silently dropped or malformed.
- An **"Advanced" free-text YAML box** (both mission- and agent-level) is the escape hatch for any field the editor doesn't have a dedicated widget for — which today includes `mission.maxCostUsd`, `missionCopilotLimits`, `agents[].limits`, and `agents[].disabledTools`. This is a second, independent way to write exactly the fields that already have (or should have) a dedicated, safe, structured write path elsewhere.
- This editor is explicitly interim: Sprint 27 already plans to retire `index.html` once the cockpit SPA gets full config-editing feature parity. The current fragility is a symptom of code that was never meant to be the long-term editing surface, not a one-off defect worth hardening in place.

Separately, ADR-0016 already gave every mission a **mission copilot** — a normal team member with a `SaveMissionConfig` tool (structured JSON partial patch, no client-side YAML parsing at all). It can read the mission's current state before writing, explain a change, and — because it is itself one of the agents whose prompt shapes this exact behavior — has a natural interest in getting it right. This capability already exists and is unaffected by any of the above; the question this ADR answers is which surface *should* own which fields, not how to build a new one.

---

## Decision

**The operator has direct, full control over their own mission's config.** Everything with a
stored value and a coherent form widget is control-plane-editable, suspended-only, through the
Config panel — including `systemPrompt` and `supervisor`. The mission copilot's `SaveMissionConfig`
remains available as a chat-driven alternative (useful when the operator wants the copilot's help
drafting or reasoning about a change), but it is not the only path, and the control plane is never
gated behind it.

### Control plane — editable, before and after launch

| Field | Why |
|---|---|
| `mission.name` | Pure display label, zero operational effect. |
| `mission.model` / `mission.visionModel` | The most common operator action (cost/capability tradeoff). Scalar, dropdown-driven (model catalog already exists), no free text. |
| `mission.timezone` | Scalar IANA string, a display/scheduling preference, no agent has special insight into it. |
| `agents[].name` | Display label. |
| `agents[].model` | Same reasoning as `mission.model`, one level down. |
| `agents[].active` | Boolean lifecycle toggle — "does this agent exist in future boots." |
| `agents[].disabledSkills` / `agents[].disabledTools` | Structured multi-select, not free text. Needs a first-class checkbox widget for `disabledTools` (previously only reachable through the removed Advanced box). |
| `agents[].supervisor` | Changes the team's reporting/escalation structure. Validated wholesale by `parseTeamConfig` on save, same as every other field in this table — the operator owns their own team shape directly. |
| `agents[].systemPrompt` | The highest-value field in the schema, and exactly why the operator should be able to edit it directly rather than only through an intermediary. |
| Live mental-map content | HTML, edited via a CodeMirror source/preview toggle; a server-side mechanical guard (`managedRegionKeys()`) blocks a save that would silently drop a daemon-managed section. See "Post-ADR-0022 addendum" below for the viewer/editor detail. |

`mission.maxCostUsd`, `missionCopilotLimits`, and `agents[].limits` are **control-plane-owned but not part of this editor** — they already have a dedicated, purpose-built, always-live-applying path (the cockpit's Limits panel, `PATCH /:id/limits/*`, ADR-0018) and must not be reachable through a second, less-validated route. This is a stronger claim than "also fine here": a mission (or a compromised one) must not be able to raise its own spending ceiling unchecked (see threat-model F-025), so these fields being *only* operator-writable, through *one* code path, is itself the security property, not an implementation detail.

### Mission plane also (`SaveMissionConfig`) — a chat-driven alternative, not the only path

| Field | Why |
|---|---|
| `agents[].initialMentalMap` (post-launch) | **Inert once an agent has run once** — the live mental map (`conversationMessages`) is what's actually used, and the operator's own direct edit (Config panel, suspended-only) targets that correctly. Showing this as an editable post-launch field is worse than risky: it looks like it does something and doesn't. Removed from the post-launch editor entirely, not just moved. |
| `teamFiles` content (skill/prompt files) | No dedicated control-plane editor widget yet — `write_mission_file` (control-plane copilot *and* mission copilot) is the tool-mediated, single-file path today. The control-plane editor's Files tab is view-only (list + read, no add/edit/remove). |

### Neither — immutable or infrastructure, not exposed as "editable" anywhere

| Field | Why |
|---|---|
| `agents[].id` | Changing it orphans the agent's entire history (mental maps, stats, mailbox addressing, other agents' `supervisor` references). Fixed at template-authoring time. |
| `agents[].linuxUser` | System-managed (`ensureAgentUsers`), not a config decision. |
| `agents[].role` | Free text but purely cosmetic (display only, doesn't affect behavior). Dropped from the editor along with the other free-text fields — not worth carving out a special case for. |

### Mechanism: no client-side YAML round-trip for editing, at all

The bug's proximate cause was the multi-hop text conversion, not just the specific fields exposed. The fix removes the conversion path entirely for the write side, not just the risky fields within it:

- The editor now holds the mission's structured config (`mission`, `agents`, `teamFiles` as received from `GET /:id/config`) as **opaque cached objects**, mutating only the fields above via ordinary form inputs — a plain multi-line `<textarea>` for `systemPrompt`, a text input for `supervisor`, no special-casing beyond that.
- **Save** clones the cached objects and overlays the edited fields (`{ ...cachedAgent, name, active, model, disabledSkills, disabledTools, supervisor, systemPrompt }`) — every remaining field (`initialMentalMap`, `limits`, `linuxUser`, `id`) passes through byte-for-byte from what the server returned, never touched by `jsyaml`.
- `parseYamlBlocks`/`parseMissionHeader`/`parseAgentBlock`/`buildMissionHeader`/`buildAgentBlock`/`reconstructYaml`/`yamlToStructured` (the whole client-side YAML conversion layer added in ADR-0021's structured-storage migration to keep this editor working) are deleted. A read-only "Raw YAML" preview tab is kept, generated once via `jsyaml.dump()` purely for display — it is never parsed back, so it cannot corrupt anything even if malformed.
- The "Advanced" free-text box (mission- and agent-level) is removed. There is no longer a way to bypass the field allowlist from this UI.

### Before vs. after launch

At the time of this ADR, pre-launch customization beyond the chosen template was not offered at all — an operator launched a template as-is, then asked the copilot to adjust something once running. Sprint 28b's `"draft"` mission status and Draft Editor superseded that: a draft has no running agent to collide with, so it gets its own always-editable editor (`DraftEditor.tsx`) with direct, unconfirmed write access, including to `systemPrompt`/`supervisor`/`initialMentalMap` and the agent roster itself — see `docs/adr/0021-structured-mission-config-storage.md`'s deferred discriminated-union note and the mission-prep implementation for detail. This ADR's Config panel governs an already-launched mission only.

---

## Consequences

- **The exact bug class that caused this ADR cannot recur in this editor** — every field, editable or not, round-trips through structured JSON (`GET`/`PUT /:id/config`), never through `jsyaml`, so there is no lossy text conversion left to corrupt anything.
- **The operator can edit `systemPrompt`/`supervisor` directly**, suspended-only, with the same `parseTeamConfig` validation every other field in this editor already relies on. The mission copilot's `SaveMissionConfig` stays available as a chat-driven alternative for when the operator wants help drafting or reasoning about a change, not as a gate the operator must go through.
- **`agents[].disabledTools` gets its first dedicated widget** — previously only reachable through the now-removed Advanced box, so this is a net usability improvement bundled into the risk reduction, not a regression.
- Consistent with the already-planned Sprint 27 retirement of `index.html` — this narrows its scope rather than investing further in its long-term architecture.

---

## Post-ADR-0022 addendum — live mental map moved back to control-plane-editable

**Date**: 2026-08-11

The cockpit's Config panel (the Sprint 27 successor to `index.html`, which this ADR already
anticipated — see Consequences) originally kept the live mental map read-only, matching the
table above. Reopened for two reasons, neither of which existed when the original decision was
made:

1. **The panel's own rendering was worse than plain text.** The mental map is HTML, but the
   read-only view was a bare, unstyled `<textarea>` — hard to read as structure, not even a
   plain-text improvement over what it replaced. Fixing readability requires a real HTML-aware
   viewer regardless of whether the field stays read-only, and once that viewer exists (see
   below), the marginal step to also allow editing through it is small.
2. **Re-examining why mental maps specifically were grouped with `systemPrompt`.** The bug this
   ADR fixed was specifically a client-side YAML round-trip losing fields — a risk that doesn't
   apply to mental maps under the *current* architecture regardless of which UI edits them:
   `PUT /:id/config`'s `mentalMaps` patch is (and always was, since ADR-0021) a plain JSON string
   field, no YAML involved, the same mechanism `save_session_config` already uses safely.
   Grouping it with `systemPrompt` bundled a field with a *mechanically checkable*
   risk (accidentally deleting a `data-managed` region) in with one that only has a *semantic*
   risk (a prompt that reads fine but is subtly wrong) — the same mitigation doesn't fit both.

**What changed:**
- The Config panel's mental-map field now renders via CodeMirror's HTML mode (syntax-highlighted
  source) with an opt-in "Preview" toggle into a sandboxed iframe (`sandbox="allow-scripts"`, no
  `allow-same-origin` — same trust boundary the Files panel's `.html` viewer already uses for
  agent-authored, possibly web-influenced content, TB-8). Read-only or editable depending on
  `canEdit`, same suspended-only gate as every other field in this panel — both client-side
  (disabled controls) and server-side (`PUT /:id/config` still 409s unless `status === "suspended"`).
- New mechanical guard, `managedRegionKeys()` (`mental-map.ts`): before saving, the server compares
  the `data-managed` attributes present in the current stored snapshot against the submitted
  version and rejects the save (400, naming the missing section) if any would be silently dropped.
  This is the piece that didn't exist at the time of the original decision — it directly replaces
  the "an actor sanity-checks the change" argument with a mechanical one, for the one risk class
  that has a mechanical answer.
- `systemPrompt` was deliberately **not** included in this particular reversal — prose has no
  equivalent structural invariant to check mechanically, unlike the managed-region guard above.
  (It is control-plane-editable today regardless — see the Decision section above — but that came
  later, as a direct policy call rather than a new mechanical mitigation like this one.)
- The mission copilot's own mental map (previously not visible anywhere in this panel — it isn't
  in `mission.agents`, injected in-memory only, ADR-0016) is now shown/editable the same way,
  reusing the same `GET`/`PUT /:id/config` fields keyed by `MISSION_COPILOT_AGENT_ID`. Its
  `systemPrompt` is shown read-only for visibility only — it isn't a stored field at all
  (synthesized fresh each session via `buildMissionCopilotAgentConfig`), so there is nothing to
  save back regardless of this addendum.

**Why this isn't "the bug could still happen a different way":** the corruption ADR-0022 fixed
was a mechanical one (a lossy format conversion), fixed structurally for every field, editable or
not, by deleting the conversion layer entirely. What's being reopened here is a policy decision
made on top of that fix — the split was correct as reasoned at the time, and the reasoning for
`systemPrompt` still holds. What changed is only that a mechanical check now exists for the other
half of that decision.

---

## Related

- [ADR-0021](0021-structured-mission-config-storage.md) — introduced the structured `GET`/`PUT /:id/config` shape this ADR's editor now consumes directly, and the client-side YAML conversion layer this ADR deletes
- [ADR-0018](0018-limit-configuration-single-source-fresh-reads.md) — the Limits panel path `mission.maxCostUsd`/`missionCopilotLimits`/`agents[].limits` must stay confined to
- `docs/security/threat-model.md` — F-025 (mission copilot raising its own spend cap unconfirmed) — the same reasoning applies in reverse here: a spend cap must stay operator-only, reachable through one path
- `packages/agent-runtime-worker/src/mission-copilot-tools.ts` — `SaveMissionConfig`, `write_mission_file`
- `packages/control-plane/public/index.html` — the editor this ADR scopes down
- `packages/agent-runtime-worker/src/mental-map.ts` — `managedRegionKeys()`, the mechanical guard the addendum above relies on
- `packages/cockpit/src/ConfigPanel.tsx` — the cockpit editor implementing the addendum's mental-map viewer/editor and mission-copilot tab
