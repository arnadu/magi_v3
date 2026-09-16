import { join } from "node:path";
import { ObjectId } from "mongodb";
import { MonitorServer } from "../monitor-server.js";
import { WorkspaceGit } from "../workspace-git.js";
import type { BootContext } from "./context.js";

/**
 * Validate MONITOR_PORT/TOOL_PORT (bare process.exit(1) on an invalid value
 * — never needs to unwind through main()'s scope), derive the active-agent
 * roster and sharedDir, and start the SSE dashboard MonitorServer.
 *
 * ToolApiServer construction/listen is a separate phase (same file) despite
 * sitting right next to this in the original code — split for size/fan-in,
 * per the plan; toolPort is validated here since it's the same trivial
 * pattern as monitorPort and both need validating before either server
 * starts.
 */
export async function startMonitorServer(
	ctx: Pick<
		BootContext,
		| "db"
		| "missionId"
		| "teamConfig"
		| "modelId"
		| "usageAccumulator"
		| "statsCollector"
		| "missionConfigRepo"
		| "mailboxRepo"
		| "ac"
		| "workdir"
		| "visionModel"
	>,
): Promise<
	Pick<
		BootContext,
		"monitorPort" | "toolPort" | "sharedDir" | "workspaceGit" | "monitor"
	>
> {
	const monitorPort = Number.parseInt(process.env.MONITOR_PORT ?? "4000", 10);
	if (!Number.isFinite(monitorPort) || monitorPort < 1 || monitorPort > 65535) {
		console.error(
			`Error: MONITOR_PORT must be 1–65535, got: ${process.env.MONITOR_PORT}`,
		);
		process.exit(1);
	}

	const toolPort = Number.parseInt(process.env.TOOL_PORT ?? "4001", 10);
	if (!Number.isFinite(toolPort) || toolPort < 1 || toolPort > 65535) {
		console.error(
			`Error: TOOL_PORT must be 1–65535, got: ${process.env.TOOL_PORT}`,
		);
		process.exit(1);
	}

	const agents = ctx.teamConfig.agents
		.filter((a) => a.active !== false)
		.map((a) => ({
			id: a.id,
			name: a.name ?? a.id,
			role: a.role ?? a.id,
		}));
	const sharedDir = join(ctx.workdir, "missions", ctx.missionId, "shared");
	// Shared between the orchestrator (agent turn-end commits) and MonitorServer
	// (operator file-edit commits) — one serialized queue, so the two can never
	// race each other on .git/index.lock.
	const workspaceGit = new WorkspaceGit(sharedDir);
	const monitor = new MonitorServer(
		ctx.db,
		ctx.missionId,
		ctx.teamConfig.mission.name,
		ctx.modelId,
		ctx.usageAccumulator,
		ctx.statsCollector,
		ctx.missionConfigRepo,
		ctx.mailboxRepo,
		agents,
		() => ctx.ac.abort(),
		new Date(),
		ctx.workdir,
		sharedDir,
		async (id) => {
			// missionId-scoped: without it, any valid ObjectId (guessed or
			// leaked from another mission) could cancel a different mission's
			// scheduled message — the same missing-scope bug class Track 1
			// fixed for the control-plane copilot's B1 tools, found here too.
			await ctx.db
				.collection("scheduled_messages")
				.deleteOne({ _id: new ObjectId(id), missionId: ctx.missionId });
		},
		undefined, // publicDir — use the default
		workspaceGit,
	);
	// Vision model for the upload pipeline's image captioning (Sprint 25).
	monitor.visionModel = ctx.visionModel;
	await monitor.start(monitorPort);
	process.stdout.write(
		`[daemon] Monitor server listening on port ${monitorPort}\n`,
	);

	return { monitorPort, toolPort, sharedDir, workspaceGit, monitor };
}
