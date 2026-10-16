/**
 * Fly machine state → mission status, for the cockpit's live refresh of a
 * mission document (`GET /api/missions/:id`).
 */

import type { MissionDoc } from "./missions.js";

/**
 * Maps a live Fly machine state to a mission status, or `null` when the state
 * doesn't confidently indicate one (leave the mission's current status alone).
 *
 * `null` for "created"/"replacing" — not `"error"` — matters because
 * `provisionMission`/`resumeMission` return as soon as Fly accepts the
 * create/start call, without waiting for the machine to reach "started".
 * A mission doc is written as "running" immediately after that, making it
 * eligible for this live-refresh check on the very next `GET /:id` — which
 * the cockpit fires within milliseconds via a mount-only effect right after
 * navigating to the new mission. Mapping the machine's still-transient state
 * to "error" flipped brand-new, fully-provisioned missions to error within
 * seconds (found live, 2026-09-11 — twice, both with machineId/volumeId/
 * privateIp all set and no errorMessage, the fingerprint of this path rather
 * than a real provisioning failure).
 *
 * The `default` case gets the same treatment: Fly has no first-class "failed"
 * machine state (a crash surfaces as "stopped" with a nonzero exit code in a
 * separate events field, not here), so an unrecognized state is ambiguous,
 * not evidence of failure — overwriting a known-good status with "error" and
 * no explanation is worse than leaving it stale until the next successful
 * refresh.
 *
 * A "destroyed"/"destroying" machine maps to "suspended", not "destroyed". The
 * mission status "destroyed" means the operator's DELETE ran and the volume is
 * gone too; it is written only by that route and hides the mission from every
 * list. A machine that disappears on its own (deleted in the Fly dashboard,
 * reaped by Fly, lost to a failed resize) leaves the data volume intact, and
 * POST /:id/resume already re-provisions onto it whether or not the old machine
 * still exists — so the honest status is "suspended, machine gone", which the
 * operator can act on. Found live 2026-10-16: two running missions vanished
 * from the cockpit after their machines were deleted out of band; their
 * volumes were untouched and one resume call each brought them back.
 */
export function liveStateToStatus(
	flyState: string,
): MissionDoc["status"] | null {
	switch (flyState) {
		case "started":
		case "starting":
			return "running";
		case "stopped":
		case "stopping":
		case "destroyed":
		case "destroying":
			return "suspended";
		case "created":
		case "replacing":
			return null;
		default:
			console.warn(
				`[missions] unrecognized Fly machine state "${flyState}" — leaving mission status unchanged`,
			);
			return null;
	}
}
