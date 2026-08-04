# ADR-0026 — Direction for sensitive-personal-data encryption (Sprint 29)

**Status**: Proposed — records research-to-date and a direction; implementation deferred to
Sprint 29, pending the deeper research this ADR itself calls for
**Sprint**: 29 (planned)
**Date**: 2026-08-03

---

## Context

The operator wants to use MAGI V3 for sensitive personal data. That requires encrypting stored
data so MAGI V3's own infrastructure providers — Fly.io and MongoDB Atlas, named explicitly —
cannot read it, wherever technically possible. LLM providers are explicitly out of scope for
opacity (they must see plaintext to process a request); the ask there is to minimize retention,
not eliminate visibility.

**Baseline (confirmed by direct inspection, 2026-08-03):** zero application-level encryption
exists anywhere in the codebase today (`grep -rln "encrypt|KMS|CSFLE" packages/` = zero hits).
`docs/security/threat-model.md` documents only WireGuard transport encryption; there is no at-rest
or provider-opacity posture documented anywhere. This is net-new capability, not a gap in an
existing feature.

**Data footprint this would need to cover:**

| Store | Contents | Current protection |
|---|---|---|
| MongoDB (`conversationMessages`, `mailbox`, `llmCallLog`, `missions`, `objectivesGoals/Events`, `missionAnomalies`) | Full agent conversation history, inter-agent/operator messages, per-call audit log, mission config | Atlas-managed encryption at rest (Atlas holds the key), TLS in transit |
| Fly Volumes (per-mission `sharedDir` / private workdirs) | Agent-written documents, uploaded attachments, mission files | Fly-managed encryption at rest, on by default (`--no-encryption` to opt out) — Fly holds the key |

**Research findings, per layer:**

- **Fly Volumes** — encrypted at rest by default, but Fly's own docs stop at "encryption-at-rest
  enabled"; no customer-managed-key option is documented anywhere. Fly can decrypt volume contents
  with its own key. The only way to make this opaque to Fly is application-level encryption:
  encrypt file bytes before they're written, decrypt on read. All mission file I/O already funnels
  through a bounded set of chokepoints (`document-processor.ts`; the monitor server's
  `/upload`, `/download`, `/files/shared/edit` routes), so this is a wrapper at those points, not a
  rewrite.
- **MongoDB Atlas** — three tiers researched, with materially different opacity properties:
  - *Encryption at Rest with Customer Key Management (CMK)* — you hold the master key in your own
    cloud KMS, but Atlas still decrypts into memory to run queries. Gives key revocation control,
    **not** provider opacity.
  - *Client-Side Field Level Encryption (CSFLE)* and *Queryable Encryption* — the driver encrypts
    specific fields before they leave the client process; per MongoDB's own docs, "the server has
    no knowledge of the data it processes." This is the tier that actually achieves opacity.
  - MAGI_V3's sensitive content is large free-text blobs (`content`, `body`) rather than
    structured fields queried by value — nothing in the codebase filters `conversationMessages` or
    `mailbox` by message content, only by `missionId`/`agentId`/`turnNumber`/`timestamp`. That
    means the full automatic-encryption schema machinery CSFLE/Queryable Encryption ship with
    (built for "encrypt this field but still query it") is more machinery than needed. **Explicit
    (manual) client-side encryption** of just the payload fields, at the existing repository
    chokepoints (`conversation-repository.ts`, `mailbox.ts`), leaving routing/metadata fields
    plaintext, covers the actual access pattern with less integration surface.
- **Anthropic API (direct calls)** — standard retention is 7 days, never used for training absent
  explicit permission. Self-serve Zero Data Retention does not exist; ZDR is enterprise-only,
  granted per-organization via a sales conversation. At MAGI_V3's current scale this is very
  likely impractical to pursue as a purchased arrangement — the realistic floor for direct
  Anthropic calls is "7 days, documented," not zero.
- **OpenRouter (routes DeepSeek, Kimi, Z.AI, Mistral per `models.ts`)** — has a self-serve `zdr:
  true` provider-routing flag, settable per-request through the same `compat.openRouterRouting`
  mechanism `withOpenRouterAffinity()` already uses for cache-affinity routing (ADR-0024). Cheap,
  concrete, no new infrastructure. The caveat: the effective guarantee is the union of OpenRouter's
  setting and each specific upstream provider's own ZDR support, and OpenRouter's docs don't state
  whether a request fails closed or silently falls back to a non-ZDR endpoint when no compliant
  route exists for the requested model. That behavior needs empirical verification, per upstream
  provider actually in use, before this ships — a silent fallback would be worse than not having
  the flag.

## Decision

Pursue **opt-in, per-mission application-level encryption**, not a blanket change:

1. **Fly Volumes** — encrypt file bytes at the existing I/O chokepoints before write; decrypt on
   read. Independent of Fly's own default volume encryption (which remains on as defense-in-depth
   against physical/disk compromise, but doesn't achieve opacity to Fly itself).
2. **MongoDB** — explicit client-side encryption of the `content`/`body` payload fields on
   `conversationMessages` and `mailbox` (the two collections holding free-text mission content),
   using envelope encryption: a KMS-held master key wraps a per-mission (or per-user) data
   encryption key. Metadata fields used for routing and queries stay plaintext.
3. **LLM retention** — add `zdr: true` to the OpenRouter provider-routing config once fail-open/
   fail-closed behavior is verified per upstream provider. Direct Anthropic calls keep standard
   7-day retention as a documented, accepted trade-off; self-serve ZDR isn't available at this
   scale.
4. **Opt-in, not global** — a per-mission flag, off by default. Most missions (e.g. equity
   research on public market data) don't need the added latency, KMS cost, and complexity that
   encrypt/decrypt on every conversation read/write would add to the hot path.

This is recorded as a **direction**, not a committed design — Status is `Proposed`, and several
questions below need to be resolved through dedicated research before implementation starts, not
guessed at in this ADR.

## Open questions for the deeper research pass (Sprint 29)

- **KMS provider choice.** Fly.io isn't hosted on AWS/GCP/Azure natively, so any of AWS KMS, GCP
  KMS, or Azure Key Vault is a new external dependency regardless of which is picked — need a
  concrete comparison (cost, latency, SDK ergonomics from a Fly Machine) before choosing.
  Considered and rejected without a KMS: a self-managed master key would remove the "provider
  can't read it" guarantee if the key ever transits through Fly or Mongo infrastructure — the
  whole point of a KMS is the master key never leaves it.
- **Key custody model.** Does "customer" mean the MAGI_V3 operator holds the KMS account (current
  single-operator reality), or does each end user get their own key in a future multi-tenant
  world? This is a product decision that changes the KMS integration shape, not just an
  implementation detail — needs to be settled before wiring code, not discovered mid-build.
- **Migration path** for mission data already stored in plaintext under existing missions.
- **Hot-path performance** — per-message encrypt/decrypt sits on every LLM turn's conversation
  read/write; needs a latency budget check before rollout, not just after.
- **Fail-open/fail-closed verification** for OpenRouter `zdr: true` against each upstream provider
  actually in use (DeepSeek, Kimi, Z.AI, Mistral) — a live test per provider, not just documentation
  reading.
- **Opt-in mechanism** — likely a new mission-config field plus a cockpit toggle; exact shape not
  designed yet.
- **Key rotation and revocation.** Also worth evaluating as a potential feature rather than pure
  overhead: deleting a mission's DEK renders its encrypted data permanently unrecoverable
  (crypto-shredding) — this could double as the mission-deletion mechanism rather than requiring
  separate cascade-delete logic across every collection and the Fly volume.

## Consequences

- A new external KMS dependency is a new trust boundary and subprocessor — `threat-model.md` gets
  updated when this is actually implemented, not now (nothing is built yet).
- This is sized as its own sprint (29), not folded into Sprint 28's existing scope (out-of-band
  alerting, onboarding, usage dashboard, `/security-review` pass) — different shape of work (new
  infrastructure dependency, a per-mission product decision on opt-in UX) than Sprint 28's
  operational-hardening items.
- Nothing here changes LLM providers' visibility into plaintext during inference — that remains
  fundamental to how the system works, and out of scope by the operator's own framing.

## Related

- `packages/agent-runtime-worker/src/models.ts` — `withOpenRouterAffinity()`, the existing
  `compat.openRouterRouting` mechanism `zdr: true` would extend (ADR-0024)
- `packages/agent-runtime-worker/src/conversation-repository.ts`,
  `packages/agent-runtime-worker/src/mailbox.ts` — chokepoints for MongoDB explicit encryption
- `packages/agent-runtime-worker/src/document-processor.ts`, monitor server upload/download/
  file-edit routes — chokepoints for Fly volume file encryption
- `docs/security/threat-model.md` — to be updated when a KMS dependency is actually added
