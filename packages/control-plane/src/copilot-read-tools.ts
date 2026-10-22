import {
	type MissionDoc,
	type ScheduledMessageDoc,
	storedCollection,
} from "@magi/agent-config";
import { type MagiTool, UPGRADE_LIMITS } from "@magi/agent-runtime-worker";
import { Type } from "@sinclair/typebox";
import type { Db, Filter } from "mongodb";
import {
	type CopilotToolDeps,
	err,
	monitorFetch,
	ok,
} from "./copilot-tool-deps.js";
import { getMachineState, volumeExists } from "./fly-machines.js";
import {
	defaultShapeOf,
	getOpenSegment,
	upgradedMsSince,
} from "./machine-segments.js";
import { latestResourceSample } from "./resource-queries.js";
import {
	getTemplate as getTemplateData,
	listTemplates as listTemplateData,
} from "./templates.js";

function listMissionsTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "ListMissions",
		description: "List all missions with their current status.",
		parameters: Type.Object({}),
		async execute() {
			const missions = await storedCollection(db, "missions")
				.find({ userId }, { sort: { createdAt: -1 } })
				.toArray();
			if (missions.length === 0) return ok("(no missions)");
			const rows = missions
				.map((m) => `${m.missionId} | ${m.name} | ${m.status}`)
				.join("\n");
			return ok(rows);
		},
	};
}

async function liveMachineState(
	machineId: string | undefined,
): Promise<string> {
	if (!machineId) return "(no machine)";
	try {
		return await getMachineState(machineId);
	} catch (e) {
		return `error: ${(e as Error).message}`;
	}
}

/** Machine tier, how long it has been on it, and upgraded runtime against the cap. */
async function runtimeLines(
	db: Db,
	mission: MissionDoc,
	now: Date,
): Promise<string[]> {
	const shape = mission.upgrade ?? defaultShapeOf(mission);
	const tierLine = `tier:      ${shape.cpuKind}, ${shape.cpus} CPU${shape.cpus === 1 ? "" : "s"}, ${shape.memoryMb} MB${mission.upgrade ? ` (upgraded, expires ${mission.upgrade.expiresAt.toISOString()})` : " (default)"}`;
	const openSegment = await getOpenSegment(db, mission.missionId).catch(
		() => null,
	);
	const sinceLine = openSegment
		? `onTierSince: ${openSegment.startedAt.toISOString()}`
		: "onTierSince: (unknown — no runtime segment recorded)";
	const usedMs = await upgradedMsSince(
		db,
		mission.missionId,
		mission.upgradedRuntimeResetAt ?? new Date(0),
		now,
		"elapsed",
	).catch(() => 0);
	const upgradedLine = `upgradedRuntime: ${(usedMs / 3_600_000).toFixed(1)} h / ${UPGRADE_LIMITS.cumulativeCapHours} h used since last reset`;
	return [tierLine, sinceLine, upgradedLine];
}

async function diskSampleLine(
	db: Db,
	missionId: string,
	now: Date,
): Promise<string> {
	const sample = await latestResourceSample(db, missionId).catch(() => null);
	if (sample?.diskUsedBytes === undefined || !sample.diskTotalBytes) {
		return "disk:      (no sample yet)";
	}
	const age = sample.updatedAt
		? `${Math.round((now.getTime() - sample.updatedAt.getTime()) / 60_000)} min old`
		: "age unknown";
	return `disk:      ${(sample.diskUsedBytes / 1024 ** 3).toFixed(1)} / ${(sample.diskTotalBytes / 1024 ** 3).toFixed(1)} GB (sample ${age})`;
}

/**
 * Checked live against Fly, not just what MongoDB says: issue #62's incident
 * was a copilot inferring "volume destroyed" from error text with no way to
 * check.
 */
async function verifiedVolumeLine(mission: MissionDoc): Promise<string> {
	if (!mission.volumeId) return "volume:    (no volumeId on record)";
	if (mission.machineId?.startsWith("local-")) {
		return `volumeId:  ${mission.volumeId} (local execution — not a real Fly volume)`;
	}
	try {
		return (await volumeExists(mission.volumeId))
			? `volumeId:  ${mission.volumeId} (verified on Fly)`
			: `volumeId:  ${mission.volumeId} (NOT FOUND on Fly — mission.volumeId has likely drifted; see mission-recovery skill)`;
	} catch (e) {
		return `volumeId:  ${mission.volumeId} (could not verify: ${(e as Error).message})`;
	}
}

function getMissionStatusTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "GetMissionStatus",
		description:
			"Get full status of a mission including live Fly machine state.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission) return err(`Mission "${missionId}" not found`);

			const now = new Date();
			const [machineState, runtime, diskLine, volumeLine] = await Promise.all([
				liveMachineState(mission.machineId),
				runtimeLines(db, mission, now),
				diskSampleLine(db, missionId, now),
				verifiedVolumeLine(mission),
			]);
			const summary = [
				`missionId: ${mission.missionId}`,
				`name:      ${mission.name}`,
				`status:    ${mission.status}`,
				`machineId: ${mission.machineId ?? "(none)"}`,
				`privateIp: ${mission.privateIp ?? "(none)"}`,
				`liveState: ${machineState}`,
				...runtime,
				diskLine,
				volumeLine,
				`createdAt: ${mission.createdAt.toISOString()}`,
				`updatedAt: ${mission.updatedAt.toISOString()}`,
			].join("\n");
			return ok(summary);
		},
	};
}

function readMissionMailboxTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "ReadMissionMailbox",
		description: "Read recent messages from any mission's mailbox.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
			limit: Type.Optional(
				Type.Number({ description: "Max messages to return (default 20)" }),
			),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const limit = (args.limit as number | undefined) ?? 20;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission) return err(`Mission "${missionId}" not found`);
			const msgs = await storedCollection(db, "mailbox")
				.find({ missionId }, { sort: { timestamp: -1 }, limit })
				.toArray();
			if (msgs.length === 0) return ok("(mailbox empty)");
			const text = msgs
				.reverse()
				.map(
					(m) =>
						`[${(m.timestamp as Date).toISOString()}] ${m.from} → ${(m.to as string[]).join(",")} | ${m.subject}\n${m.body}`,
				)
				.join("\n\n---\n\n");
			return ok(text);
		},
	};
}

function readMissionLogTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "ReadMissionLog",
		description:
			"Read the daemon log for a running mission from its monitor server.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
			lines: Type.Optional(
				Type.Number({
					description: "Number of log lines to return (default 100)",
				}),
			),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const lines = (args.lines as number | undefined) ?? 100;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission?.privateIp)
				return err(`Mission "${missionId}" has no private IP — is it running?`);
			try {
				const text = await monitorFetch(
					mission.privateIp,
					mission.missionId,
					`/log?lines=${lines}`,
				);
				return ok(text || "(empty log)");
			} catch (e) {
				return err(`Failed to read log: ${(e as Error).message}`);
			}
		},
	};
}

function readMissionFileTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "ReadMissionFile",
		description:
			"Browse or read files in a mission's sharedDir or an agent's workdir.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
			path: Type.String({
				description:
					'Relative path within the directory. Use "/" to list the root.',
			}),
			agentId: Type.Optional(
				Type.String({
					description:
						"If set, browse the agent's private workdir instead of sharedDir.",
				}),
			),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const userPath = args.path as string;
			const agentId = args.agentId as string | undefined;

			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission?.privateIp)
				return err(`Mission "${missionId}" has no private IP — is it running?`);

			const endpoint = agentId
				? `/files/workdir/${encodeURIComponent(agentId)}?path=${encodeURIComponent(userPath)}`
				: `/files/shared?path=${encodeURIComponent(userPath)}`;

			try {
				const text = await monitorFetch(
					mission.privateIp,
					mission.missionId,
					endpoint,
				);
				return ok(text);
			} catch (e) {
				return err(`Failed to read file: ${(e as Error).message}`);
			}
		},
	};
}

function listScheduleTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "ListSchedule",
		description: "List scheduled messages, optionally filtered by mission.",
		parameters: Type.Object({
			missionId: Type.Optional(
				Type.String({ description: "Filter to this mission ID" }),
			),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string | undefined;
			// F-024 fix: scope by the caller's own missions either way — a single
			// mission is verified via ownership lookup first (matching
			// ReviewObjectives/ReadMissionMailbox), and the "all missions" case
			// queries only the caller's own mission IDs (matching ListMissions),
			// since ScheduledMessageDoc itself carries no userId to filter on
			// directly.
			let filter: Filter<ScheduledMessageDoc>;
			if (missionId) {
				const mission = await storedCollection(db, "missions").findOne({
					missionId,
					userId,
				});
				if (!mission) return err(`Mission "${missionId}" not found`);
				filter = { missionId };
			} else {
				const ownedMissionIds = (
					await storedCollection(db, "missions")
						.find({ userId }, { projection: { missionId: 1 } })
						.toArray()
				).map((m) => m.missionId);
				filter = { missionId: { $in: ownedMissionIds } };
			}
			const docs = await storedCollection(db, "scheduledMessages")
				.find(filter, { sort: { deliverAt: 1 } })
				.toArray();
			if (docs.length === 0) return ok("(no scheduled messages)");
			const rows = docs
				.map(
					(d) =>
						`[${d._id}] ${d.missionId} | ${d.status} | ${d.deliverAt.toISOString()} | ${d.subject}`,
				)
				.join("\n");
			return ok(rows);
		},
	};
}

function listTemplatesTool(_deps: CopilotToolDeps): MagiTool {
	return {
		name: "ListTemplates",
		description:
			"List available mission team config templates. Templates are immutable " +
			"(disk-authored, ADR-0021) — there is no version history to browse.",
		parameters: Type.Object({}),
		async execute() {
			const all = listTemplateData();
			if (all.length === 0) return ok("(no templates)");
			return ok(all.map((t) => `${t.id} | ${t.name}`).join("\n"));
		},
	};
}

function getTemplateTool(_deps: CopilotToolDeps): MagiTool {
	return {
		name: "GetTemplate",
		description:
			"Get the full config and associated files for a team config template.",
		parameters: Type.Object({
			id: Type.String({ description: "Template ID" }),
		}),
		async execute(_id, args) {
			const templateId = args.id as string;
			const template = getTemplateData(templateId);
			if (!template) return err(`Template "${templateId}" not found`);

			const fileList =
				template.teamFiles.length > 0
					? template.teamFiles.map((f) => f.path).join("\n")
					: "(none)";

			const text = [
				`=== Template: ${template.id} (${template.name}) ===`,
				"",
				JSON.stringify(template.config, null, 2),
				"",
				`=== Files ===`,
				fileList,
			].join("\n");
			return ok(text);
		},
	};
}

function readMentalMapTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "ReadMentalMap",
		description:
			"Read an agent's current mental map (its durable HTML memory) — the map save_session_config's mentalMaps would replace. Read it before proposing an edit, and send back the whole map with only your section changed.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
			agentId: Type.String({ description: "Agent ID" }),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const agentId = args.agentId as string;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission) return err(`Mission "${missionId}" not found`);
			// The same document the daemon loads and save_session_config writes.
			const latest = await storedCollection(db, "conversationMessages").findOne(
				{ agentId, missionId, mentalMapHtml: { $exists: true } },
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			if (!latest?.mentalMapHtml) {
				return err(
					`No mental map recorded for "${agentId}" in mission "${missionId}" (the agent has not run yet, or the id is wrong)`,
				);
			}
			return ok(latest.mentalMapHtml);
		},
	};
}

export function createReadTools(deps: CopilotToolDeps) {
	return {
		listMissions: listMissionsTool(deps),
		getMissionStatus: getMissionStatusTool(deps),
		readMissionMailbox: readMissionMailboxTool(deps),
		readMentalMap: readMentalMapTool(deps),
		readMissionLog: readMissionLogTool(deps),
		readMissionFile: readMissionFileTool(deps),
		listSchedule: listScheduleTool(deps),
		listTemplates: listTemplatesTool(deps),
		getTemplate: getTemplateTool(deps),
	};
}
