/**
 * Copilot HTTP + SSE routes.
 *
 * POST /api/copilot/message   — inject an operator message into the copilot mailbox
 * GET  /api/copilot/events    — SSE stream of copilot events (messages, actions, etc.)
 * POST /api/copilot/confirm   — confirm and execute a proposed action
 * POST /api/copilot/dismiss   — dismiss a pending action without executing
 *
 * Each authenticated user gets an isolated copilot daemon (missionId = "copilot-{userId}")
 * started lazily on first message, or when mail arrives for it (copilot-waker.ts).
 * SSE events are routed per-user.
 */

import { storedCollection } from "@magi/agent-config";
import { createMongoMailboxRepository } from "@magi/agent-runtime-worker";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { Db } from "mongodb";
import { asyncRoutes } from "./async-handler.js";
import { executeAction } from "./copilot-action-handlers.js";
import { COPILOT_WORKDIR, copilotWorkdirFor } from "./copilot-daemon.js";
import { readCopilotFileNode } from "./copilot-files.js";
import { createPendingActionRoutes } from "./copilot-pending-routes.js";
import type { CopilotRuntime } from "./copilot-runtime.js";
import {
	COPILOT_AGENT_ID,
	checkCopilotSpendCap,
	readCopilotSpend,
} from "./copilot-spend.js";
import type { PendingActionsStore } from "./pending-actions.js";
import {
	queryLlmCall,
	queryLlmCalls,
	queryTranscript,
	queryTurns,
} from "./transcript-queries.js";
import { lifetimeUsage } from "./usage-queries.js";
import {
	getCopilotModel,
	getCopilotSpendCap,
	setCopilotModel,
	setCopilotSpendCap,
} from "./users.js";

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCopilotRouter(
	db: Db,
	pending: PendingActionsStore,
	runtime: CopilotRuntime,
): Router {
	const router = createRouter();
	const routes = asyncRoutes(router);
	const { eventBus, defaultModelId } = runtime;

	// ── POST /api/copilot/message ─────────────────────────────────────────────

	routes.post("/message", async (req: Request, res: Response) => {
		const { subject, body } = req.body as {
			subject?: string;
			body?: string;
		};
		if (!body || typeof body !== "string") {
			res.status(400).json({ error: "body is required" });
			return;
		}

		const missionId = `copilot-${req.userId}`;
		const capError = await checkCopilotSpendCap(db, req.userId);
		if (capError !== null) {
			res.status(402).json({ error: capError });
			return;
		}

		// Post BEFORE starting the daemon (not after): on a cold start,
		// startCopilotDaemon's watch loop checks for unread mail before it opens
		// its Change Stream, so a message that already exists in the mailbox is
		// always seen — no dependency on exactly when the stream becomes live.
		// Reversed, a message inserted right after the daemon starts could race
		// ahead of the stream actually being open and be silently missed (the
		// daemon is otherwise event-only, so a missed wake-up looks like the
		// copilot never responding).
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const msg = await mailboxRepo.post({
			missionId,
			from: "user",
			to: ["copilot"],
			subject: subject ?? "(no subject)",
			body,
		});

		await runtime.ensureCopilotRunning(req.userId);

		res.json({ ok: true, id: msg.id });
	});

	// ── GET/POST /api/copilot/settings ────────────────────────────────────────
	// The copilot's model is per-user today. When per-mission copilots land
	// (deferred — see GitHub #14), this resolution order extends naturally:
	// mission-level copilot model override -> this user-level setting -> the
	// MODEL env var fallback. No rework needed here for that later.

	routes.get("/settings", async (req: Request, res: Response) => {
		const model = await getCopilotModel(db, req.userId);
		res.json({
			model: model ?? defaultModelId,
			isDefault: model === undefined,
		});
	});

	routes.post("/settings", async (req: Request, res: Response) => {
		const { model } = req.body as { model?: string | null };
		if (model !== null && model !== undefined && typeof model !== "string") {
			res.status(400).json({ error: "model must be a string or null" });
			return;
		}

		// Guard against switching models mid-turn: stop() only aborts the signal
		// — it does not wait for the in-flight runAgent() call to unwind, and the
		// very next /message call starts a fresh daemon immediately, racing the
		// old one's still-in-progress final write. Found live: that race left a
		// tool_use persisted with no result (the tool never ran), permanently
		// corrupting the copilot's history — every later session failed
		// identically, regardless of which model it replayed against. Rejecting
		// here instead of aborting mid-flight is simpler and more honest than
		// trying to sequence the abort/restart correctly, and matches how the
		// operator was already retrying by hand.
		if (runtime.getDaemon(req.userId)?.isBusy()) {
			res.status(409).json({
				error:
					"Copilot is currently running a turn — wait for it to finish before changing the model.",
			});
			return;
		}

		await setCopilotModel(db, req.userId, model ?? undefined);

		// The running daemon (if any) captured the old model at startup and
		// won't pick up the change on its own — stop it so the next message
		// triggers a fresh ensureCopilotRunning() with the new model. Safe now:
		// the busy check above already ruled out an in-flight turn.
		runtime.stopDaemon(req.userId);

		res.json({ ok: true, model: model ?? defaultModelId });
	});

	// ── GET /api/copilot/usage ───────────────────────────────────────────────

	routes.get("/usage", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		res.json(await lifetimeUsage(db, missionId));
	});

	// ── GET /api/copilot/history ──────────────────────────────────────────────
	// The mailbox already stores both sides of the conversation:
	//   operator → copilot:  { from: "user",    to: ["copilot"] }
	//   copilot  → operator: { from: "copilot", to: ["user"]    }
	// No separate collection needed.

	routes.get("/history", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const raw = await storedCollection(db, "mailbox")
			.find({
				missionId,
				$or: [{ from: "user" }, { to: "user" }],
			})
			.sort({ timestamp: -1 })
			.limit(50)
			.toArray();

		const entries = raw.reverse().map((m) => ({
			role: m.from === "user" ? "user" : "assistant",
			body: m.body as string,
			subject: m.subject as string,
			timestamp: m.timestamp,
		}));
		res.json(entries);
	});

	// ── GET /api/copilot/turns, /transcript, /llm-calls, /llm-call ─────────────
	// Same data shape as the mission Transcripts tab (`/api/missions/:id/...`),
	// but scoped directly by req.userId — no `missions` collection document
	// exists for "copilot-{userId}", so there's no ownership lookup to do; the
	// userId is already the whole scope. See transcript-queries.ts.

	routes.get("/turns", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		res.json(await queryTurns(db, missionId, COPILOT_AGENT_ID));
	});

	routes.get("/transcript", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const turn = Number(req.query.turn);
		if (Number.isNaN(turn)) {
			res.status(400).json({ error: "turn query param required" });
			return;
		}
		res.json(await queryTranscript(db, missionId, COPILOT_AGENT_ID, turn));
	});

	routes.get("/llm-calls", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const turn = Number(req.query.turn);
		if (Number.isNaN(turn)) {
			res.status(400).json({ error: "turn query param required" });
			return;
		}
		res.json(await queryLlmCalls(db, missionId, COPILOT_AGENT_ID, turn));
	});

	routes.get("/llm-call", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const turn = Number(req.query.turn);
		const i = Number(req.query.i);
		if (Number.isNaN(turn) || Number.isNaN(i)) {
			res.status(400).json({ error: "turn and i query params required" });
			return;
		}
		const detail = await queryLlmCall(db, missionId, COPILOT_AGENT_ID, turn, i);
		if (!detail) {
			res.status(404).json({ error: "call not found" });
			return;
		}
		res.json(detail);
	});

	// ── GET /api/copilot/files ──────────────────────────────────────────────
	// Direct filesystem read, not a proxy — the copilot runs in-process in the
	// control-plane container, so COPILOT_WORKDIR is on this process's own
	// filesystem. See copilot-files.ts for the path-boundary/symlink guard.

	// X-TENANT3: a user sees only their own copilot's subdirectory. Admins
	// see the whole workdir, which also keeps files written before per-user
	// subdirectories existed reachable to someone.
	router.get("/files", (req: Request, res: Response) => {
		const userPath = (req.query.path as string | undefined) ?? "";
		const root = req.isAdmin
			? COPILOT_WORKDIR
			: copilotWorkdirFor(`copilot-${req.userId}`);
		const node = readCopilotFileNode(root, userPath);
		if (node === null) {
			res.status(400).json({ error: "Path outside root" });
			return;
		}
		res.json(node);
	});

	// ── GET/PATCH /api/copilot/limits ───────────────────────────────────────

	routes.get("/limits", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const [capUsd, spentUsd] = await Promise.all([
			getCopilotSpendCap(db, req.userId),
			readCopilotSpend(db, missionId),
		]);
		res.json({ capUsd: capUsd ?? null, spentUsd });
	});

	routes.patch("/limits", async (req: Request, res: Response) => {
		const { capUsd } = req.body as { capUsd?: number | null };
		if (capUsd !== null && capUsd !== undefined && typeof capUsd !== "number") {
			res.status(400).json({ error: "capUsd must be a number or null" });
			return;
		}
		if (typeof capUsd === "number" && capUsd <= 0) {
			res.status(400).json({ error: "capUsd must be positive" });
			return;
		}
		await setCopilotSpendCap(db, req.userId, capUsd ?? undefined);
		res.json({ ok: true, capUsd: capUsd ?? null });
	});

	// ── GET /api/copilot/events ───────────────────────────────────────────────
	// Auth already ran (requireAuth is mounted above this router); the browser's
	// EventSource sends the HttpOnly session cookie with `withCredentials`.

	router.get("/events", (req: Request, res: Response) => {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();

		// Keepalive ping every 25 s to prevent proxy timeouts.
		const keepalive = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch {
				clearInterval(keepalive);
			}
		}, 25_000);

		eventBus.addClient(req.userId, res);

		req.on("close", () => {
			clearInterval(keepalive);
			eventBus.removeClient(req.userId, res);
		});
	});

	// Proposed-action confirmation, replay and dismissal (copilot-pending-routes.ts).
	router.use(
		createPendingActionRoutes({ db, pending, eventBus, executeAction }),
	);

	return router;
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

export { executeAction };
