/**
 * Why a mission's machine stopped, for the copilot and the machine-down alert.
 *
 * The daemon answers for itself while it runs (`/log`, heartbeats); a daemon
 * that fails at boot answers nothing, and the evidence is then only on Fly:
 * the machine's exit events and its log buffer. Without them a crash at boot
 * looked like any stopped machine, and the copilot guessed "out of memory".
 */
import {
	apiToken,
	appName,
	type FlyMachineEvent,
	type FlyMachineSummary,
	flyFetch,
} from "./fly-machines.js";

export interface MachineExit {
	exitedAt: string;
	exitCode?: number;
	oomKilled: boolean;
	requestedStop: boolean;
}

/** The latest exit among a machine's retained events (Fly keeps about five). */
export function lastExit(
	events: FlyMachineEvent[] | undefined,
): MachineExit | null {
	let latest: FlyMachineEvent | undefined;
	for (const e of events ?? []) {
		if (e.type !== "exit" || !e.request?.exit_event) continue;
		if (!latest || (e.timestamp ?? 0) > (latest.timestamp ?? 0)) latest = e;
	}
	const x = latest?.request?.exit_event;
	if (!latest || !x) return null;
	return {
		exitedAt:
			x.exited_at ??
			(latest.timestamp
				? new Date(latest.timestamp).toISOString()
				: "(unknown time)"),
		exitCode: x.exit_code,
		oomKilled: x.oom_killed === true || x.signal === 9 || x.guest_signal === 9,
		requestedStop: x.requested_stop === true,
	};
}

/**
 * A machine that is stopped because its process failed, and that Fly will not
 * start again by itself: its restarts are used up. A requested stop (suspend,
 * resize) and a clean exit are not crashes.
 */
export function isCrashStopped(
	machine: Pick<FlyMachineSummary, "state" | "events">,
): boolean {
	if (machine.state !== "stopped") return false;
	const exit = lastExit(machine.events);
	if (!exit || exit.requestedStop) return false;
	return exit.oomKilled || (exit.exitCode !== undefined && exit.exitCode !== 0);
}

/** One line for GetMissionStatus and the alert: what the last exit was, read from Fly. */
export function describeLastExit(
	machine: Pick<FlyMachineSummary, "state" | "events">,
): string {
	const exit = lastExit(machine.events);
	if (!exit) return "no exit recorded in the machine's retained events";
	const parts = [
		`at ${exit.exitedAt}`,
		`exit code ${exit.exitCode ?? "unknown"}`,
		exit.oomKilled ? "an out-of-memory kill" : "not an out-of-memory kill",
		exit.requestedStop ? "a requested stop" : "not a requested stop",
	];
	const verdict = isCrashStopped(machine)
		? "; the process failed and Fly's restarts are used up, so it stays stopped until resumed (read the machine's log with ReadMissionLog for the reason)"
		: "";
	return `${parts.join(", ")}${verdict}`;
}

export async function getMachine(
	machineId: string,
): Promise<FlyMachineSummary> {
	const res = await flyFetch(
		`/apps/${appName()}/machines/${encodeURIComponent(machineId)}`,
	);
	if (!res.ok)
		throw new Error(`Failed to get machine ${machineId}: ${res.status}`);
	return (await res.json()) as FlyMachineSummary;
}

const FLY_LOGS_BASE = "https://api.fly.io/api/v1/apps";
const LOG_TIMEOUT_MS = 15_000;
const MAX_LOG_LINE_CHARS = 500;

export interface MachineLogLine {
	timestamp: string;
	message: string;
}

/**
 * The machine's recent log lines from Fly's log buffer (about the last 100, in
 * order; on a busy machine the buffer can lag behind). The host is fixed and the
 * machine id comes from the mission document, never from the caller.
 */
export async function fetchMachineLog(
	machineId: string,
	fetchFn: typeof fetch = fetch,
): Promise<MachineLogLine[]> {
	const token = apiToken();
	const url = `${FLY_LOGS_BASE}/${encodeURIComponent(appName())}/logs?instance=${encodeURIComponent(machineId)}&next_token=`;
	const res = await fetchFn(url, {
		signal: AbortSignal.timeout(LOG_TIMEOUT_MS),
		// The logs API takes a macaroon as `FlyV1 <token>`, which is how deploy
		// tokens are issued; it refuses one sent as a bearer token.
		headers: {
			Authorization: token.startsWith("FlyV1 ") ? token : `Bearer ${token}`,
		},
	});
	if (!res.ok) throw new Error(`Fly refused the log read: ${res.status}`);
	const body = (await res.json()) as {
		data?: Array<{ attributes?: { timestamp?: unknown; message?: unknown } }>;
	};
	return (body.data ?? []).map((d) => ({
		timestamp:
			typeof d.attributes?.timestamp === "string" ? d.attributes.timestamp : "",
		message:
			typeof d.attributes?.message === "string"
				? d.attributes.message.slice(0, MAX_LOG_LINE_CHARS)
				: "",
	}));
}
