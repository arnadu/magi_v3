# Spend limits

MAGI spends money on your LLM provider account every time an agent thinks. Nothing about an
LLM-driven system stops it from spending on its own, so spend is bounded in layers. Each layer
protects against whoever can change the layer inside it.

| Layer | What it limits | Who can change it | Where |
|---|---|---|---|
| **Your LLM provider's hard limit** | Everything, whatever MAGI does | You, at the provider | Provider console. Keep it set, with auto-replenish off. |
| **Platform ceiling** | How high any mission's ceiling may go | The platform owner | `PLATFORM_MAX_COST_CEILING_USD` (default $100) |
| **Mission ceiling** | How high the mission's cap may go — by anyone, including the mission copilot | The mission's owner, up to the platform ceiling; a platform admin, above it | Cockpit → mission → Limits → "Spend-cap ceiling" |
| **Mission cap** | The mission's total spend: when reached, every agent pauses | The owner, and the mission copilot's own tools — never above the ceiling | Cockpit → Limits → "Mission spend cap" (new missions start at $25) |
| **Per-agent limits** | One agent's spend or calls per turn and lifetime; soft limits alert, hard limits stop the turn | The owner, the mission copilot | Cockpit → Limits → per agent |

Every mission always has a cap. A config save that leaves the cap out keeps the one already
stored, a mission that never had one gets the $25 default before any machine of it starts, and a
daemon that somehow finds no cap enforces the default anyway. No config save can set the cap
above the mission's ceiling.

## Why the outer layers are restricted

- **The mission ceiling exists because of the mission copilot.** The copilot is an LLM that reads
  its teammates' output, which can include text from web pages. It can raise the cap, and once did
  so on its own (issue #49). The ceiling is a field no mission tool can write, so a confused or
  manipulated copilot can only raise the cap so far.
- **The platform ceiling exists because of other users.** Every mission spends on the platform's
  provider keys. Without a platform-level limit, any signed-in user could raise their own ceiling
  and spend the platform owner's money without bound. Only the platform owner sets it.

A **platform admin** is the admin key (`CONTROL_API_KEY`) or any signed-in user whose Firebase UID
is listed in `PLATFORM_ADMIN_USER_IDS`. Admins may set a mission's ceiling above the platform
ceiling from the cockpit.

## When a mission has reached its budget

1. Open the mission → Limits. The card shows the spend so far, the cap and the ceiling.
2. If the new cap you want is above the ceiling, raise the ceiling first ("Save ceiling"), then
   the cap ("Save cap"). The panel says how high the ceiling can go for you.
3. A suspended mission keeps the new cap and applies it at its next resume; a running one applies
   it at once (the cockpit, the control-plane copilot and the mission copilot all push it to the
   mission machine).

### What "paused" means

When the cap is reached, nothing new is dispatched, and every turn already running stops before
its next LLM call (including the calls of a Research sub-agent inside it). The tool call in
progress finishes; nothing is cut off. When the cap is raised the paused turns carry on where they
stopped. A turn's wall-clock limit (`MAX_AGENT_RUN_SECONDS`, 4 h) keeps counting during the pause,
so a turn paused longer than that is ended as timed out; its next mail starts a new turn.

Background jobs count too: every LLM call a job makes through the Tool API (Research, FetchUrl,
InspectImage) is charged to the agent that submitted it and checked against the cap, and while the
mission is paused those tools answer 503. The job itself keeps running; its other tools (data
providers, PostMessage) still work.

If the ceiling you need is above the platform ceiling and you are not a platform admin, ask one —
or, if you own the platform, add your UID to `PLATFORM_ADMIN_USER_IDS`, or raise
`PLATFORM_MAX_COST_CEILING_USD`:

```bash
flyctl secrets set -a magi-control-<env> PLATFORM_ADMIN_USER_IDS=<your-firebase-uid>
```

Your UID is the `userId` field of `/api/auth/me` while signed in to the cockpit.

## The control-plane copilot

Each user's control-plane copilot spends on the platform's provider keys too, so it has a hard cap
of its own: $25 by default (`DEFAULT_COPILOT_SPEND_CAP_USD`), counted over the copilot's lifetime.
The user manages it from the cockpit: home → Copilot → **Limits**, which shows the spend against
the cap. There they can save a new cap, or reset it to the default. There is no "no cap", and only
a platform admin may set it above the platform ceiling.

The cap is checked before every copilot turn and again after every LLM call inside one, counting
the turn in progress. When it is reached the copilot stops, mid-turn if need be, and says so in
the chat, until the cap is raised. Every turn is also stopped after 20 minutes
(`COPILOT_MAX_TURN_MS`). A batch of messages whose turn fails three times in a row is set aside
with an error in the chat instead of being retried forever.

## Related

- Decision record: [ADR-0034](adr/0034-spend-containment-defaults.md) (defaults, ceilings, the
  2026-10-18 back-fill amendment)
- All environment variables: [env.md](env.md)
- The control-plane copilot's cap: see above (`packages/control-plane/src/copilot-spend.ts`).
