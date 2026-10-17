/**
 * Routes for proposed copilot actions: confirm (atomic claim, executed as the
 * proposing user), replay for a reconnecting cockpit, and dismiss.
 */

import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { Db } from "mongodb";
import { asyncHandler, asyncRoutes } from "./async-handler.js";
import type { CopilotEventBus } from "./copilot-runtime.js";
import type { PendingAction, PendingActionsStore } from "./pending-actions.js";

export interface PendingActionRoutesDeps {
	db: Db;
	pending: PendingActionsStore;
	eventBus: CopilotEventBus;
	executeAction: (
		db: Db,
		action: PendingAction,
		userId: string,
	) => Promise<string>;
}

export function createPendingActionRoutes(
	deps: PendingActionRoutesDeps,
): Router {
	const { db, pending, eventBus, executeAction } = deps;
	const router = createRouter();
	const routes = asyncRoutes(router);

	// ── POST /api/copilot/confirm ─────────────────────────────────────────────

	routes.post("/confirm", async (req: Request, res: Response) => {
		const { pendingActionId } = req.body as { pendingActionId?: string };
		if (!pendingActionId) {
			res.status(400).json({ error: "pendingActionId is required" });
			return;
		}

		const action = await pending.get(pendingActionId);
		if (!action) {
			res
				.status(404)
				.json({ error: "Pending action not found or already executed" });
			return;
		}

		if (!req.isAdmin && action.userId !== req.userId) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}

		// Atomic claim: a second click (or a second tab) finds nothing to take
		// and gets a 409 instead of a second execution.
		const taken = await pending.take(pendingActionId);
		if (!taken) {
			res.status(409).json({ error: "Pending action already executed" });
			return;
		}

		// The action executes as the user whose copilot proposed it — an admin
		// confirming another user's card acts on that user's missions, not
		// their own (EA3). The result goes to that user's cockpit, where the
		// card is.
		try {
			const result = await executeAction(db, taken, taken.userId);
			eventBus.push(taken.userId, "copilot-action-result", {
				id: pendingActionId,
				ok: true,
				result,
			});
			res.json({ ok: true, result });
		} catch (e) {
			const msg = (e as Error).message;
			eventBus.push(taken.userId, "copilot-action-result", {
				id: pendingActionId,
				ok: false,
				error: msg,
			});
			res.status(500).json({ error: msg });
		}
	});

	// ── GET /api/copilot/pending ──────────────────────────────────────────────
	// Cards still awaiting confirmation — replayed by the cockpit on connect,
	// since the store now survives a control-plane restart.

	router.get(
		"/pending",
		asyncHandler(async (req: Request, res: Response) => {
			const actions = await pending.listForUser(req.userId);
			res.json({
				actions: actions.map((a) => ({
					id: a.id,
					type: a.type,
					label: a.label,
					payload: a.payload,
					createdAt: a.createdAt,
				})),
			});
		}),
	);

	// ── POST /api/copilot/dismiss ─────────────────────────────────────────────

	router.post(
		"/dismiss",
		asyncHandler(async (req: Request, res: Response) => {
			const { pendingActionId } = req.body as { pendingActionId?: string };
			if (!pendingActionId) {
				res.status(400).json({ error: "pendingActionId is required" });
				return;
			}
			const action = await pending.get(pendingActionId);
			if (action && !req.isAdmin && action.userId !== req.userId) {
				res.status(403).json({ error: "Forbidden" });
				return;
			}
			await pending.delete(pendingActionId);
			res.json({ ok: true });
		}),
	);

	return router;
}
