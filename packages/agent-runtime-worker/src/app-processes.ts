/**
 * An app's process: started as its owner through `magi-app`, signalled as
 * its owner (the daemon cannot signal another user's processes; sudo does
 * not relay signals), checked by connecting to its loopback port, and
 * measured from /proc. Kept apart from the supervisor so the sudo boundary
 * reads on its own.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { type AppLaunch, MAGI_APP } from "./app-commands.js";

const KILL_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 3_000;

export interface AppProcesses {
	/** Start the app detached (its own process group, pgid = the returned pid). */
	start(linuxUser: string, launch: AppLaunch, logFd: number): ChildProcess;
	/** Signal the whole process group as the app's owner; false when it could not be delivered. */
	signal(
		pgid: number,
		linuxUser: string,
		sig: "TERM" | "KILL",
	): Promise<boolean>;
	/** True when something accepts a connection on 127.0.0.1:port. */
	answers(port: number): Promise<boolean>;
	/** True when nothing listens on 127.0.0.1:port yet. */
	portFree(port: number): Promise<boolean>;
	/** Resident memory of the process group, in MB. */
	rssMb(pgid: number): number;
}

export const appProcesses: AppProcesses = {
	start(linuxUser, launch, logFd) {
		return spawn("sudo", ["-n", "-u", linuxUser, MAGI_APP, ...launch.argv], {
			cwd: launch.cwd,
			env: {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: `/home/${linuxUser}`,
				...launch.env,
			},
			detached: true,
			stdio: ["ignore", logFd, logFd],
		});
	},
	signal(pgid, linuxUser, sig) {
		return new Promise((resolve) => {
			execFile(
				"sudo",
				[
					"-n",
					"-u",
					linuxUser,
					MAGI_APP,
					"/bin/sh",
					"-c",
					'kill -s "$1" -- "-$2"',
					"magi-kill",
					sig,
					String(pgid),
				],
				{ timeout: KILL_TIMEOUT_MS, env: { PATH: "/usr/bin:/bin" } },
				(err) => {
					if (err)
						console.error(
							`[apps] signal ${sig} to process group ${pgid} as ${linuxUser} failed: ${err.message}; the app may keep running until the daemon restarts`,
						);
					resolve(!err);
				},
			);
		});
	},
	answers(port) {
		return new Promise((resolve) => {
			const s = createConnection({ host: "127.0.0.1", port });
			const done = (ok: boolean) => {
				s.destroy();
				resolve(ok);
			};
			s.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
			s.once("connect", () => done(true));
			s.once("error", () => done(false));
		});
	},
	portFree(port) {
		return new Promise((resolve) => {
			const srv = createServer();
			srv.once("error", () => resolve(false));
			srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
		});
	},
	rssMb(pgid) {
		let kb = 0;
		for (const pid of readdirSync("/proc")) {
			if (!/^\d+$/.test(pid)) continue;
			try {
				// Field 5 of /proc/<pid>/stat is the process group; the command
				// name (field 2) may hold spaces, so count from its closing paren.
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				if (Number(rest[2]) !== pgid) continue;
				const m = readFileSync(`/proc/${pid}/status`, "utf8").match(
					/VmRSS:\s+(\d+) kB/,
				);
				if (m) kb += Number(m[1]);
			} catch {
				// The process exited between the listing and the read: not counted.
			}
		}
		return Math.round(kb / 1024);
	},
};
