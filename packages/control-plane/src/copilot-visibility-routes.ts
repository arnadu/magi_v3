/**
 * The copilot's own Transcripts, Files and Limits panels — the same shapes as
 * a mission's (`/api/missions/:id/...`), scoped by the session's user id:
 * the copilot's "mission" is `copilot-{userId}` and has no missions
 * document, so the user id is the whole scope.
 */

import type { Request, Response, Router } from "express";
import type { Db } from "mongodb";
import type { asyncRoutes } from "./async-handler.js";
import { COPILOT_WORKDIR, copilotWorkdirFor } from "./copilot-daemon.js";
import { readCopilotFileNode } from "./copilot-files.js";
import { COPILOT_AGENT_ID, readCopilotSpend } from "./copilot-spend.js";
import {
	queryLlmCall,
	queryLlmCalls,
	queryTranscript,
	queryTurns,
} from "./transcript-queries.js";
import { getCopilotSpendCap, setCopilotSpendCap } from "./users.js";

export function registerCopilotVisibilityRoutes(
	router: Router,
	routes: ReturnType<typeof asyncRoutes>,
	db: Db,
): void {
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
}
