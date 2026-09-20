/**
 * Per-user control-plane copilot daemon lifecycle, shared by the copilot
 * routes (which start a daemon on the operator's first message) and the
 * copilot waker (which starts one when mail arrives for a user whose daemon
 * isn't running — ADR-0032).
 */

import type { Response } from "express";
import type { Db } from "mongodb";
import {
	type CopilotDaemonHandle,
	startCopilotDaemon,
} from "./copilot-daemon.js";
import type { PendingActionsStore } from "./copilot-tools.js";
import { getCopilotModel } from "./users.js";

// ---------------------------------------------------------------------------
// Per-user SSE event bus
// ---------------------------------------------------------------------------

export class CopilotEventBus {
	private readonly clients = new Map<string, Set<Response>>();

	addClient(userId: string, res: Response): void {
		if (!this.clients.has(userId)) this.clients.set(userId, new Set());
		this.clients.get(userId)?.add(res);
	}

	removeClient(userId: string, res: Response): void {
		this.clients.get(userId)?.delete(res);
	}

	/** Push an event only to SSE clients belonging to userId. */
	push(userId: string, type: string, data: unknown): void {
		const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
		const set = this.clients.get(userId) ?? new Set();
		for (const res of set) {
			try {
				res.write(payload);
			} catch {
				set.delete(res);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface CopilotRuntime {
	readonly eventBus: CopilotEventBus;
	/** Model used when a user has no copilotModel setting of their own. */
	readonly defaultModelId: string;
	/** Start this user's copilot daemon if it isn't running. Idempotent and safe to call concurrently. */
	ensureCopilotRunning(userId: string): Promise<void>;
	getDaemon(userId: string): CopilotDaemonHandle | undefined;
	/** Stop this user's daemon and forget it; the next ensureCopilotRunning starts a fresh one. */
	stopDaemon(userId: string): void;
}

export function createCopilotRuntime(
	db: Db,
	repoRoot: string,
	pending: PendingActionsStore,
): CopilotRuntime {
	const eventBus = new CopilotEventBus();
	const defaultModelId = process.env.MODEL ?? "claude-sonnet-4-6";
	const daemons = new Map<string, CopilotDaemonHandle>();
	// The model lookup is async, so without this two overlapping callers (an
	// operator message racing a waker wake-up) could each start a daemon for
	// the same user.
	const starting = new Map<string, Promise<void>>();

	// Resolution order: user's own copilotModel setting -> MODEL env var ->
	// hardcoded fallback. Only read at daemon start; a model change takes
	// effect by stopping the daemon (see the /settings route).
	async function start(userId: string): Promise<void> {
		const modelId = (await getCopilotModel(db, userId)) ?? defaultModelId;
		const handle = startCopilotDaemon(
			db,
			repoRoot,
			modelId,
			(type, data) => eventBus.push(userId, type, data),
			pending,
			`copilot-${userId}`,
		);
		daemons.set(userId, handle);
	}

	return {
		eventBus,
		defaultModelId,
		async ensureCopilotRunning(userId) {
			if (daemons.has(userId)) return;
			let inFlight = starting.get(userId);
			if (!inFlight) {
				inFlight = start(userId).finally(() => starting.delete(userId));
				starting.set(userId, inFlight);
			}
			await inFlight;
		},
		getDaemon: (userId) => daemons.get(userId),
		stopDaemon(userId) {
			daemons.get(userId)?.stop();
			daemons.delete(userId);
		},
	};
}
