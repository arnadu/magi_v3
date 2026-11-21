/**
 * The mission machine's firewall (ADR-0037 decision 5; F-081), through the
 * root-owned `magi-net` helper and one sudo rule.
 *
 * `init` at every boot (a machine restart resets the rules): inbound, only
 * loopback, established connections, ICMP, Fly's SSH and the monitor port;
 * on loopback, an app's port is reachable only by the daemon and the app's
 * owner, once `allow`ed. Locally (no `FLY_APP_NAME`) there is no helper and
 * nothing is filtered: the state says so, and whatever needs the firewall
 * must check it.
 */

import { execFile } from "node:child_process";
import type { MissionAnomaly } from "@magi/agent-config";

export const MAGI_NET = "/usr/local/sbin/magi-net";
const HELPER_TIMEOUT_MS = 15_000;

export type FirewallState =
	| { kind: "on" }
	| { kind: "off-local" }
	| { kind: "failed"; reason: string };

export interface MachineFirewall {
	readonly state: FirewallState;
	/** The app on `port` becomes reachable by the daemon and `uid` only. */
	allow(port: number, uid: number): Promise<void>;
	/** No one reaches `port` any more. */
	revoke(port: number): Promise<void>;
}

/** Runs the helper through sudo; rejects with its stderr on failure. */
export type RunMagiNet = (args: readonly string[]) => Promise<void>;

export const runMagiNet: RunMagiNet = (args) =>
	new Promise((resolve, reject) => {
		execFile(
			"sudo",
			["-n", MAGI_NET, ...args],
			{
				timeout: HELPER_TIMEOUT_MS,
				env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
			},
			(err, _stdout, stderr) => {
				if (err) {
					reject(new Error(stderr.trim() || err.message));
					return;
				}
				resolve();
			},
		);
	});

export interface FirewallDeps {
	missionId: string;
	/** True on a Fly machine (`FLY_APP_NAME` set), where the helper exists. */
	onFly: boolean;
	/** The daemon's AnomalyRecorder; typed here so isolation does not depend on state. */
	anomalyRecorder: {
		record(anomaly: Omit<MissionAnomaly, "createdAt">): Promise<void>;
	};
	run?: RunMagiNet;
}

export async function initMachineFirewall(
	deps: FirewallDeps,
): Promise<MachineFirewall> {
	const run = deps.run ?? runMagiNet;
	let state: FirewallState;
	if (!deps.onFly) {
		state = { kind: "off-local" };
		console.log(
			"[firewall] not on Fly: no machine firewall (local developer daemon)",
		);
	} else {
		try {
			await run(["init"]);
			state = { kind: "on" };
			console.log("[firewall] machine firewall on");
		} catch (e) {
			const reason = (e as Error).message;
			state = { kind: "failed", reason };
			console.error(
				`[firewall] magi-net init failed { missionId: "${deps.missionId}", error: "${reason}" }: inbound private-network traffic is not filtered and apps will not start`,
			);
			await deps.anomalyRecorder.record({
				missionId: deps.missionId,
				category: "firewall-failure",
				severity: "hard",
				message: `The machine firewall could not be set (${reason}). Servers started on this machine may be reachable from other machines in the organization, and apps will not start until the daemon restarts with a working firewall.`,
			});
		}
	}

	const requireOn = (what: string): void => {
		if (state.kind !== "on")
			throw new Error(
				`${what} needs the machine firewall, which is ${state.kind}`,
			);
	};
	return {
		get state() {
			return state;
		},
		async allow(port, uid) {
			requireOn(`allowing port ${port}`);
			await run(["allow", String(port), String(uid)]);
		},
		async revoke(port) {
			requireOn(`revoking port ${port}`);
			await run(["revoke", String(port)]);
		},
	};
}
