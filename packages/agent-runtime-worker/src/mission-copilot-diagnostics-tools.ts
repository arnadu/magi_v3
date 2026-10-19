import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { jobDirs } from "./job-runner.js";
import type { MissionCopilotToolDeps } from "./mission-copilot-tool-deps.js";
import { ok, okJson } from "./mission-copilot-tool-result.js";
import {
	type FileNodeLike,
	fileNodeToText,
	wrapTrustBoundary,
} from "./mission-copilot-tool-text.js";
import type { MagiTool } from "./tools.js";

// ─── Family F — Technical Diagnostics ────────────────────────────────────
function readMissionLogTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorGet } = deps;
	return {
		name: "ReadMissionLog",
		description: "Tail the daemon's own log output.",
		parameters: Type.Object({
			lines: Type.Optional(
				Type.Number({ description: "Number of lines (default 200)" }),
			),
		}),
		async execute(_id, args) {
			const lines = Math.min((args.lines as number | undefined) ?? 200, 500);
			const result = await monitorGet(`/log?lines=${lines}`);
			if (result.isError) return result;
			return ok(result.content[0].text);
		},
	};
}

function readFileHistoryTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorGet } = deps;
	return {
		name: "ReadFileHistory",
		description:
			"Git provenance for a sharedDir file — which agent/turn/commit last touched it.",
		parameters: Type.Object({
			path: Type.String({ description: "Path relative to sharedDir" }),
		}),
		async execute(_id, args) {
			const path = args.path as string;
			const result = await monitorGet(
				`/files/history?path=${encodeURIComponent(path)}`,
			);
			if (result.isError) return result;
			return ok(result.content[0].text);
		},
	};
}

function readSharedFileTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorGet } = deps;
	return {
		name: "ReadSharedFile",
		description:
			"Read any file (or list a directory) under the mission's shared workspace. File content (not directory listings) is trust-boundary-marked — any teammate can have written it, and it may itself carry content that teammate ingested from outside the mission.",
		parameters: Type.Object({
			path: Type.String({
				description: 'Path relative to sharedDir. Use "/" to list the root.',
			}),
		}),
		async execute(_id, args) {
			const path = args.path as string;
			const result = await monitorGet(
				`/files/shared?path=${encodeURIComponent(path)}`,
			);
			if (result.isError) return result;
			try {
				const parsed = JSON.parse(result.content[0].text) as FileNodeLike;
				if (parsed.type === "file") {
					return ok(
						wrapTrustBoundary(`shared file: ${path}`, fileNodeToText(parsed)),
					);
				}
			} catch {
				// fall through — return unmarked on parse failure (directory listing or unexpected shape)
			}
			return result;
		},
	};
}

function readAgentWorkdirFileTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorGet } = deps;
	return {
		name: "ReadAgentWorkdirFile",
		description:
			"Read any file (or list a directory) under one teammate's private workspace. File content is trust-boundary-marked, same reasoning as ReadSharedFile.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate whose workdir to browse" }),
			path: Type.String({
				description:
					'Path relative to their workdir. Use "/" to list the root.',
			}),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			const path = args.path as string;
			const result = await monitorGet(
				`/files/workdir/${encodeURIComponent(agentId)}?path=${encodeURIComponent(path)}`,
			);
			if (result.isError) return result;
			try {
				const parsed = JSON.parse(result.content[0].text) as FileNodeLike;
				if (parsed.type === "file") {
					return ok(
						wrapTrustBoundary(
							`${agentId}'s file: ${path}`,
							fileNodeToText(parsed),
						),
					);
				}
			} catch {
				// fall through — return unmarked on parse failure
			}
			return result;
		},
	};
}

function listBackgroundJobsTool(deps: MissionCopilotToolDeps): MagiTool {
	const { sharedDir } = deps;
	return {
		name: "ListBackgroundJobs",
		description:
			"Structured status of async background jobs (jobs/pending|running|status) — a convenience over browsing sharedDir/jobs/ by hand.",
		parameters: Type.Object({}),
		async execute() {
			const dirs = jobDirs(sharedDir);
			async function listDir(dir: string): Promise<string[]> {
				try {
					return (await readdir(dir)).filter((f) => f.endsWith(".json"));
				} catch {
					return [];
				}
			}
			async function readSpec(
				dir: string,
				file: string,
			): Promise<Record<string, unknown> | null> {
				try {
					return JSON.parse(await readFile(join(dir, file), "utf8"));
				} catch {
					return null;
				}
			}

			// Agent submissions wait in shared/jobs/pending; everything the daemon
			// itself tracks (its own queue, the running set, authoritative status)
			// lives in the private directories.
			const jobs: Array<Record<string, unknown>> = [];
			for (const dir of [dirs.pending, dirs.queue]) {
				for (const file of await listDir(dir)) {
					const spec = await readSpec(dir, file);
					if (spec) jobs.push({ ...spec, status: "pending" });
				}
			}
			for (const file of await listDir(dirs.running)) {
				const spec = await readSpec(dirs.running, file);
				if (spec) jobs.push({ ...spec, status: "running" });
			}
			for (const file of await listDir(dirs.status)) {
				const spec = await readSpec(dirs.status, file);
				if (spec) {
					jobs.push({
						...spec,
						status: spec.exitCode === 0 ? "completed" : "failed",
					});
				}
			}
			return okJson(
				jobs.map((j) => ({
					id: j.id,
					agentId: j.agentId,
					scriptPath: j.scriptPath,
					status: j.status,
					exitCode: j.exitCode,
					completedAt: j.completedAt,
				})),
			);
		},
	};
}

export function createDiagnosticsTools(deps: MissionCopilotToolDeps) {
	return {
		readMissionLog: readMissionLogTool(deps),
		readFileHistory: readFileHistoryTool(deps),
		readSharedFile: readSharedFileTool(deps),
		readAgentWorkdirFile: readAgentWorkdirFileTool(deps),
		listBackgroundJobs: listBackgroundJobsTool(deps),
	};
}
