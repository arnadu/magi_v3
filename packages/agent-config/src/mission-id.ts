/**
 * MID1 (2026-10-15 audit): mission ids were free text. The control-plane
 * copilot keeps its mailbox, conversation and stats under `copilot-<userId>`
 * (and `copilot-admin` for the CONTROL_API_KEY identity) with no `missions`
 * document, so a tenant could create a mission with one of those ids and its
 * daemon would read the victim copilot's inbox and wake it with injected
 * prompts. Every route that creates a mission from a caller-chosen id must
 * call `validateNewMissionId` first.
 *
 * Deliberately not part of `TeamConfigSchema`'s `mission.id`: every existing
 * mission's daemon re-parses its stored config at boot, so tightening the
 * shared schema would brick any already-created mission whose id predates
 * this rule. That tightening waits until stored ids are verified to conform.
 */

export const MISSION_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

/** Exact names, and `<name>-` prefixes, that belong to platform identities. */
export const RESERVED_MISSION_ID_NAMES = [
	"copilot",
	"admin",
	"platform",
	"system",
] as const;

export function validateNewMissionId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !MISSION_ID_RE.test(id)) {
		throw new Error(
			"missionId must be 3-41 characters of lowercase letters, digits and hyphens, starting with a letter or digit",
		);
	}
	const reserved = RESERVED_MISSION_ID_NAMES.find(
		(name) => id === name || id.startsWith(`${name}-`),
	);
	if (reserved) {
		throw new Error(
			`missionId "${id}" is reserved: "${reserved}" and "${reserved}-…" belong to platform identities`,
		);
	}
}
