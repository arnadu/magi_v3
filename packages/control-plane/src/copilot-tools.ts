/**
 * Copilot elevated tools — Category B tools that run in the main control-plane
 * process with full MongoDB and Fly Machines access.
 *
 * B1: Read-only tools (ListMissions, GetMissionStatus, ReadMissionMailbox,
 *     ReadMissionLog, ReadMissionFile, ListSchedule, ListTemplates, GetTemplate)
 *
 * B2: Mutating tools via ProposeAction — operator must confirm before execution.
 *     The tool pushes a `copilot-action` SSE event and returns immediately.
 *     Execution happens in copilot-router.ts when the operator confirms.
 */

import { randomUUID } from "node:crypto";
import type { MagiTool, ToolResult } from "@magi/agent-runtime-worker";
import { Type } from "@sinclair/typebox";
import type { Db } from "mongodb";
import { getMachineState } from "./fly-machines.js";
import type { MissionTemplate } from "./templates.js";

// ---------------------------------------------------------------------------
// Pending-actions store (ProposeAction ↔ /confirm endpoint)
// ---------------------------------------------------------------------------

export interface PendingAction {
	id: string;
	type: string;
	label: string;
	payload: unknown;
	createdAt: Date;
}

/** In-memory store for unconfirmed proposed actions. */
export class PendingActionsStore {
	private readonly store = new Map<string, PendingAction>();

	add(action: PendingAction): void {
		this.store.set(action.id, action);
	}

	get(id: string): PendingAction | undefined {
		return this.store.get(id);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MissionDoc {
	missionId: string;
	name: string;
	teamConfig: string;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	status: string;
	createdAt: Date;
	updatedAt: Date;
}

interface ScheduledMessageDoc {
	_id: unknown;
	missionId: string;
	to: string[];
	subject: string;
	body: string;
	deliverAt: Date;
	cron?: string;
	label?: string;
	status: "pending" | "delivered" | "cancelled";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build all Category B elevated tools for the copilot.
 *
 * @param db            MongoDB database (full access).
 * @param pushEvent     Push an SSE event to the copilot chat channel.
 * @param pending       Shared store for proposed-but-unconfirmed actions.
 */
export function createCopilotTools(
	db: Db,
	pushEvent: (type: string, data: unknown) => void,
	pending: PendingActionsStore,
): MagiTool[] {
	function ok(text: string): ToolResult {
		return { content: [{ type: "text", text }] };
	}
	function err(text: string): ToolResult {
		return { content: [{ type: "text", text }], isError: true };
	}

	/** HTTP fetch to the monitor server running on a mission's execution machine. */
	async function monitorFetch(
		privateIp: string,
		path: string,
	): Promise<string> {
		const url = `http://[${privateIp}]:4000${path}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok)
			throw new Error(`Monitor server ${privateIp} returned ${res.status}`);
		return res.text();
	}

	// ─── B1: read-only ────────────────────────────────────────────────────────

	const listMissions: MagiTool = {
		name: "ListMissions",
		description: "List all missions with their current status.",
		parameters: Type.Object({}),
		async execute() {
			const missions = await db
				.collection<MissionDoc>("missions")
				.find({}, { sort: { createdAt: -1 } })
				.toArray();
			if (missions.length === 0) return ok("(no missions)");
			const rows = missions
				.map((m) => `${m.missionId} | ${m.name} | ${m.status}`)
				.join("\n");
			return ok(rows);
		},
	};

	const getMissionStatus: MagiTool = {
		name: "GetMissionStatus",
		description:
			"Get full status of a mission including live Fly machine state.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const mission = await db
				.collection<MissionDoc>("missions")
				.findOne({ missionId });
			if (!mission) return err(`Mission "${missionId}" not found`);

			let machineState = "(no machine)";
			if (mission.machineId) {
				try {
					machineState = await getMachineState(mission.machineId);
				} catch (e) {
					machineState = `error: ${(e as Error).message}`;
				}
			}

			const summary = [
				`missionId: ${mission.missionId}`,
				`name:      ${mission.name}`,
				`status:    ${mission.status}`,
				`machineId: ${mission.machineId ?? "(none)"}`,
				`privateIp: ${mission.privateIp ?? "(none)"}`,
				`liveState: ${machineState}`,
				`createdAt: ${mission.createdAt.toISOString()}`,
				`updatedAt: ${mission.updatedAt.toISOString()}`,
			].join("\n");
			return ok(summary);
		},
	};

	const readMissionMailbox: MagiTool = {
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
			const msgs = await db
				.collection("mailbox")
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

	const readMissionLog: MagiTool = {
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
			const mission = await db
				.collection<MissionDoc>("missions")
				.findOne({ missionId });
			if (!mission?.privateIp)
				return err(`Mission "${missionId}" has no private IP — is it running?`);
			try {
				const text = await monitorFetch(
					mission.privateIp,
					`/log?lines=${lines}`,
				);
				return ok(text || "(empty log)");
			} catch (e) {
				return err(`Failed to read log: ${(e as Error).message}`);
			}
		},
	};

	const readMissionFile: MagiTool = {
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

			const mission = await db
				.collection<MissionDoc>("missions")
				.findOne({ missionId });
			if (!mission?.privateIp)
				return err(`Mission "${missionId}" has no private IP — is it running?`);

			const endpoint = agentId
				? `/files/workdir/${encodeURIComponent(agentId)}?path=${encodeURIComponent(userPath)}`
				: `/files/shared?path=${encodeURIComponent(userPath)}`;

			try {
				const text = await monitorFetch(mission.privateIp, endpoint);
				return ok(text);
			} catch (e) {
				return err(`Failed to read file: ${(e as Error).message}`);
			}
		},
	};

	const listSchedule: MagiTool = {
		name: "ListSchedule",
		description: "List scheduled messages, optionally filtered by mission.",
		parameters: Type.Object({
			missionId: Type.Optional(
				Type.String({ description: "Filter to this mission ID" }),
			),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string | undefined;
			const filter = missionId ? { missionId } : {};
			const docs = await db
				.collection<ScheduledMessageDoc>("scheduled_messages")
				.find(filter, { sort: { deliverAt: 1 } })
				.toArray();
			if (docs.length === 0) return ok("(no scheduled messages)");
			const rows = docs
				.map(
					(d) =>
						`[${d._id}] ${d.missionId} | ${d.status} | ${(d.deliverAt as Date).toISOString()} | ${d.subject}`,
				)
				.join("\n");
			return ok(rows);
		},
	};

	const listTemplates: MagiTool = {
		name: "ListTemplates",
		description: "List available mission team config templates.",
		parameters: Type.Object({}),
		async execute() {
			// Template _id is a user-defined string, not ObjectId.
			const templates = await db
				.collection<{ _id: string; name: string }>("templates")
				.find({}, { projection: { _id: 1, name: 1 } })
				.sort({ _id: 1 })
				.toArray();
			if (templates.length === 0) return ok("(no templates)");
			const rows = templates.map((t) => `${t._id} | ${t.name}`).join("\n");
			return ok(rows);
		},
	};

	const getTemplate: MagiTool = {
		name: "GetTemplate",
		description:
			"Get the full YAML and associated files for a team config template.",
		parameters: Type.Object({
			id: Type.String({ description: "Template ID" }),
		}),
		async execute(_id, args) {
			const templateId = args.id as string;
			const template = await db
				.collection<MissionTemplate>("templates")
				.findOne({ _id: templateId });
			if (!template) return err(`Template "${templateId}" not found`);

			const fileList = Array.isArray(template.teamFiles)
				? (template.teamFiles as Array<{ path: string }>)
						.map((f) => f.path)
						.join("\n")
				: "(none)";

			const text = [
				`=== Template: ${template._id} (${template.name}) ===`,
				"",
				template.teamConfigYaml as string,
				"",
				`=== Files ===`,
				fileList,
			].join("\n");
			return ok(text);
		},
	};

	// ─── B2: mutating via ProposeAction ───────────────────────────────────────

	const proposeAction: MagiTool = {
		name: "ProposeAction",
		description:
			"Propose a mutating action for operator confirmation. " +
			"The action is shown to the operator in the chat UI as a confirmation card. " +
			"This tool returns immediately — execution happens when the operator confirms.\n\n" +
			"Valid types and required payload fields:\n" +
			"- launch_mission: { missionId, name?, templateId }\n" +
			"- suspend_mission: { missionId }\n" +
			"- resume_mission: { missionId }\n" +
			"- write_mission_file: { missionId, path, content, agentId? }\n" +
			"- save_template: { id, name, teamConfigYaml, teamFiles?: [{path, content}] }\n" +
			"- save_session_config: { missionId, teamConfigYaml, teamFiles?: [{path, content}], mentalMaps?: {[agentId]: html} }\n" +
			"- cancel_schedule: { id }\n" +
			"- create_schedule: { missionId, to, subject, body, cron?, deliverAt?, label? }",
		parameters: Type.Object({
			type: Type.String({ description: "Action type (see description)" }),
			label: Type.String({
				description:
					"Short human-readable label shown on the confirmation card",
			}),
			payload: Type.Unknown({
				description:
					"Action-specific parameters. Pass as a JSON object, not a string.",
			}),
		}),
		async execute(_id, args) {
			const type = args.type as string;
			const label = args.label as string;
			const rawPayload = args.payload;
			const payload =
				typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;

			const VALID_TYPES = new Set([
				"launch_mission",
				"suspend_mission",
				"resume_mission",
				"write_mission_file",
				"save_template",
				"save_session_config",
				"cancel_schedule",
				"create_schedule",
			]);
			if (!VALID_TYPES.has(type)) {
				return err(
					`Unknown action type "${type}". Valid: ${[...VALID_TYPES].join(", ")}`,
				);
			}

			const action: PendingAction = {
				id: randomUUID(),
				type,
				label,
				payload,
				createdAt: new Date(),
			};
			pending.add(action);
			pushEvent("copilot-action", {
				id: action.id,
				type: action.type,
				label: action.label,
				payload: action.payload,
			});

			return ok(
				`Action proposed: "${label}" (id: ${action.id}).\n` +
					"Waiting for operator confirmation. You can continue your response — " +
					"execution will happen when the operator confirms.",
			);
		},
	};

	return [
		listMissions,
		getMissionStatus,
		readMissionMailbox,
		readMissionLog,
		readMissionFile,
		listSchedule,
		listTemplates,
		getTemplate,
		proposeAction,
	];
}
