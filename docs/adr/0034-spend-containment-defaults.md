# ADR-0034: Spend containment is on by default, bounded by a platform ceiling

**Status:** Accepted (2026-10-17, Sprint 28f M3)
**Supersedes / relates to:** ADR-0018 (fresh reads of the cap), F-025 (per-mission ceiling), audit findings LM1 / LIM1 / CFG2 / TPL5 / MD1 (F-067)

## Context

The spend cap (`mission.maxCostUsd`) was opt-in. No shipped template set one, the cockpit
and the copilot offered to set it but nothing required it, and both the cap and its
per-mission ceiling (F-025) were editable by the tenant who owns the mission. Several LLM
paths were not metered at all. The audit's conclusion was blunt: the platform bore unbounded
tenant spend on shared provider keys. Decision D-3 of the remediation plan chose the shape of
the fix; this ADR records it and the alternatives.

Separately, `parseModel` accepted any model id and priced an unknown one at Sonnet rates
(MD1), so a typo or an unlisted model produced a config whose cost tracking was fiction.

## Decision

1. **Every mission is created with a cap.** `withDefaultSpendCap` applies
   `DEFAULT_MISSION_MAX_COST_USD` (**$25**) when the config sets none — at `POST /api/missions`,
   draft creation, draft launch (a draft whose cap was cleared gets the default when launched)
   and the copilot's `launch_mission`. Every shipped template under `config/teams/` sets
   `maxCostUsd` explicitly, and a unit test fails if one does not.
2. **A platform ceiling bounds every cap.** `PLATFORM_MAX_COST_CEILING_USD` (default **$100**)
   is written as `maxCostCeilingUsd` on every new mission document, and back-filled once at
   control-plane start for documents that have none, so the daemon-side cap writers — which
   only know the document's own ceiling — enforce it too. A non-admin can lower a mission's
   ceiling or raise it up to the platform ceiling; only an admin (`CONTROL_API_KEY`) can set a
   mission's ceiling above it. The cap itself can never exceed the effective ceiling, whoever
   writes it (operator route, mission copilot, config save).
3. **An uncapped mission is an anomaly.** The resource monitor raises `uncapped-spend` (soft at
   $10 spent, hard at $50) for a mission whose cap was cleared after creation — the one state
   the `spend-cap-near` alert can never report on.
4. **Only known models are accepted.** `assertKnownModels` refuses a config whose `model` or
   `visionModel` is neither a platform Anthropic id (`KNOWN_ANTHROPIC_MODEL_IDS`) nor an
   OpenRouter id in pi-ai's generated registry — at mission creation, config save, draft launch,
   the copilot's `save_session_config`/`launch_draft` and the mission copilot's
   `SaveMissionConfig`. `parseModel` is unchanged for developer use.

## Alternatives considered

- **Hard-fail missions without a cap instead of defaulting.** Rejected: every existing
  creation path and the cockpit's draft editor would break for the common case; a sensible
  default plus a visible number in the Limits panel is the better operator experience, and the
  ceiling is what actually contains the platform's exposure.
- **A per-tenant budget instead of a per-mission ceiling.** The right long-term shape (it is
  what a multi-tenant deployment needs) but it requires per-tenant accounting across missions
  and the copilot, which is Sprint 29's credential-isolation work. The per-mission ceiling is
  enforceable today with the machinery F-025 already built.
- **Env-only ceiling, never stored on the document.** Rejected: the daemon's `writeMissionCap`
  and the mission copilot's `SaveMissionConfig` run on the execution plane, which has no
  `PLATFORM_MAX_COST_CEILING_USD`; storing the ceiling on the document is what makes one rule
  hold regardless of writer.
- **Accept unknown models with a warning.** Rejected: a warning in a log nobody reads is how
  MD1 happened; a 400 with the catalog route named is actionable.

## Consequences

- Operators see a $25 cap on every new mission and a $100 ceiling in the Limits panel; raising
  the cap above $100 requires an admin to raise the ceiling first.
- Pre-existing missions acquire the platform ceiling at the next control-plane start (logged
  with the count). Their caps are untouched; an uncapped one will raise `uncapped-spend` once
  it has spent $10.
- The dependency on pi-ai's generated OpenRouter registry becomes load-bearing for model
  acceptance: a brand-new OpenRouter model is refused until pi-ai ships a registry update (or
  an explicit constant is added to `models.ts`).
- Metering of the remaining unmetered LLM paths (vision calls in InspectImage and the document
  processor, the Research sub-loop, BrowseWeb) is tracked separately (COST-1) and is not part
  of this decision.
