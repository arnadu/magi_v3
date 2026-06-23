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
 *
 * B3: GitHub Issues tools (ListIssues, CreateIssue, CloseIssue, AddIssueComment) —
 *     direct GitHub REST API calls using GH_TOKEN. No operator confirmation required;
 *     GitHub issues are low-risk, fully reversible actions.
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
	/** Firebase UID of the user whose copilot proposed this action. */
	userId: string;
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
	userId: string,
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
		description:
			"List available mission team config templates (latest version of each).",
		parameters: Type.Object({}),
		async execute() {
			const latest = await db
				.collection("templates")
				.aggregate<{ _id: string; name: string; version: number }>([
					{ $sort: { version: -1 } },
					{
						$group: {
							_id: "$templateId",
							name: { $first: "$name" },
							version: { $first: "$version" },
						},
					},
					{ $sort: { _id: 1 } },
				])
				.toArray();
			if (latest.length === 0) return ok("(no templates)");
			const rows = latest
				.map((t) => `${t._id} | v${t.version} | ${t.name}`)
				.join("\n");
			return ok(rows);
		},
	};

	const getTemplate: MagiTool = {
		name: "GetTemplate",
		description:
			"Get the full YAML and associated files for a team config template (latest version).",
		parameters: Type.Object({
			id: Type.String({ description: "Template ID" }),
		}),
		async execute(_id, args) {
			const templateId = args.id as string;
			const template = await db
				.collection<MissionTemplate>("templates")
				.findOne({ templateId }, { sort: { version: -1 } });
			if (!template) return err(`Template "${templateId}" not found`);

			const fileList = Array.isArray(template.teamFiles)
				? (template.teamFiles as Array<{ path: string }>)
						.map((f) => f.path)
						.join("\n")
				: "(none)";

			const text = [
				`=== Template: ${template.templateId} v${template.version} (${template.name}) ===`,
				"",
				template.teamConfigYaml as string,
				"",
				`=== Files ===`,
				fileList,
			].join("\n");
			return ok(text);
		},
	};

	const listTemplateVersions: MagiTool = {
		name: "ListTemplateVersions",
		description:
			"List the full version history for a template. " +
			"Every save_template is a new version — nothing is ever deleted. " +
			"Use restore_template_version (via ProposeAction) to make an old version current again.",
		parameters: Type.Object({
			id: Type.String({ description: "Template ID" }),
		}),
		async execute(_id, args) {
			const templateId = args.id as string;
			const versions = await db
				.collection<MissionTemplate>("templates")
				.find(
					{ templateId },
					{
						projection: {
							version: 1,
							name: 1,
							createdAt: 1,
							createdBy: 1,
							teamFiles: 1,
						},
					},
				)
				.sort({ version: -1 })
				.toArray();
			if (versions.length === 0)
				return ok(`No versions found for template "${templateId}"`);
			const rows = versions.map(
				(v) =>
					`v${v.version} | ${v.createdAt.toISOString()} | ${v.createdBy} | ${(v.teamFiles ?? []).length} files | ${v.name}`,
			);
			return ok(rows.join("\n"));
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
			"- save_template: { id, name, teamConfigYaml, teamFiles?: [{path, content}], fromMissionId?: string }\n" +
			"  teamFiles rules: omit teamFiles entirely to preserve whatever the template already has (safe for YAML-only edits);\n" +
			"  pass teamFiles explicitly to replace them; use fromMissionId (a running mission id) to snapshot its sharedDir instead.\n" +
			"  WARNING: passing teamFiles: [] will clear all attached files — only do this intentionally.\n" +
			"  Each save archives the previous state — use ListTemplateVersions to see history and restore_template_version to roll back.\n" +
			"- restore_template_version: { templateId, version } — roll back a template to an archived version (archives current state first)\n" +
			"- save_session_config: { missionId, teamConfigYaml, teamFiles?: [{path, content}], mentalMaps?: {[agentId]: html} }\n" +
			"- cancel_schedule: { id }\n" +
			"- create_schedule: { missionId, to, subject, body, cron?, deliverAt?, label? }\n" +
			"- pause_agent: { missionId, agentId } — halt one agent at its next dispatch boundary (e.g. a runaway flagged by a limit alert)\n" +
			"- resume_agent: { missionId, agentId } — lift a previous pause\n" +
			"- set_mission_budget: { missionId, capUsd } — set the mission's absolute spending cap in USD",
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
				"restore_template_version",
				"save_session_config",
				"cancel_schedule",
				"create_schedule",
				"pause_agent",
				"resume_agent",
				"set_mission_budget",
			]);
			if (!VALID_TYPES.has(type)) {
				return err(
					`Unknown action type "${type}". Valid: ${[...VALID_TYPES].join(", ")}`,
				);
			}

			const action: PendingAction = {
				id: randomUUID(),
				userId,
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

	// ─── B3: GitHub Issues ───────────────────────────────────────────────────

	const GITHUB_REPO = process.env.GITHUB_REPO ?? "arnadu/magi_v3";
	const GH_TOKEN = process.env.GH_TOKEN;

	async function ghFetch(
		path: string,
		options: RequestInit = {},
	): Promise<Response> {
		if (!GH_TOKEN)
			throw new Error(
				"GH_TOKEN is not set — cannot access GitHub API. Set it in bootstrap.sh.",
			);
		return fetch(`https://api.github.com${path}`, {
			...options,
			headers: {
				Authorization: `Bearer ${GH_TOKEN}`,
				Accept: "application/vnd.github.v3+json",
				"Content-Type": "application/json",
				...options.headers,
			},
		});
	}

	const listIssues: MagiTool = {
		name: "ListIssues",
		description:
			"List open GitHub Issues in the MAGI repository. " +
			"Use to check known bugs and deferred items before raising a new issue. " +
			"Optionally filter by label: bug, enhancement, deferred, ux, security.",
		parameters: Type.Object({
			label: Type.Optional(
				Type.String({
					description: "Filter by label name (omit for all open issues)",
				}),
			),
		}),
		async execute(_id, args) {
			const label = args.label as string | undefined;
			const qs = label ? `&labels=${encodeURIComponent(label)}` : "";
			try {
				const res = await ghFetch(
					`/repos/${GITHUB_REPO}/issues?state=open&per_page=50${qs}`,
				);
				if (!res.ok) return err(`GitHub API returned ${res.status}`);
				const issues = (await res.json()) as Array<{
					number: number;
					title: string;
					labels: Array<{ name: string }>;
					body: string | null;
					html_url: string;
					created_at: string;
				}>;
				if (issues.length === 0) return ok("(no open issues)");
				const rows = issues
					.map((i) => {
						const labels =
							i.labels.map((l) => l.name).join(", ") || "(no labels)";
						const first = (i.body ?? "").split("\n")[0].slice(0, 120);
						return `#${i.number} [${labels}] ${i.title}${first ? `\n  ${first}` : ""}`;
					})
					.join("\n\n");
				return ok(rows);
			} catch (e) {
				return err(`GitHub API error: ${(e as Error).message}`);
			}
		},
	};

	const createIssue: MagiTool = {
		name: "CreateIssue",
		description:
			"Create a GitHub Issue in the MAGI repository. " +
			"Use to record bugs or deferred improvements discovered during a session. " +
			"Always call ListIssues first to avoid duplicates. " +
			"Good body structure: **Observed:** … **Expected:** … **Impact:** … **Proposed fix:** …",
		parameters: Type.Object({
			title: Type.String({
				description: "Issue title — concise, action-oriented",
			}),
			body: Type.String({ description: "Issue body (markdown)" }),
			labels: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Labels to apply: bug, enhancement, deferred, ux, security",
				}),
			),
		}),
		async execute(_id, args) {
			const title = args.title as string;
			const body = args.body as string;
			const labels = (args.labels as string[] | undefined) ?? [];
			try {
				const res = await ghFetch(`/repos/${GITHUB_REPO}/issues`, {
					method: "POST",
					body: JSON.stringify({ title, body, labels }),
				});
				if (!res.ok) {
					const text = await res.text();
					return err(`GitHub API returned ${res.status}: ${text}`);
				}
				const issue = (await res.json()) as {
					number: number;
					html_url: string;
				};
				return ok(`Created #${issue.number}: ${issue.html_url}`);
			} catch (e) {
				return err(`GitHub API error: ${(e as Error).message}`);
			}
		},
	};

	const closeIssue: MagiTool = {
		name: "CloseIssue",
		description:
			"Close a GitHub Issue, optionally adding a closing comment first.",
		parameters: Type.Object({
			number: Type.Number({ description: "Issue number" }),
			comment: Type.Optional(
				Type.String({ description: "Closing comment to add before closing" }),
			),
		}),
		async execute(_id, args) {
			const number = args.number as number;
			const comment = args.comment as string | undefined;
			try {
				if (comment) {
					const cRes = await ghFetch(
						`/repos/${GITHUB_REPO}/issues/${number}/comments`,
						{ method: "POST", body: JSON.stringify({ body: comment }) },
					);
					if (!cRes.ok) return err(`Failed to add comment: ${cRes.status}`);
				}
				const res = await ghFetch(`/repos/${GITHUB_REPO}/issues/${number}`, {
					method: "PATCH",
					body: JSON.stringify({ state: "closed" }),
				});
				if (!res.ok) return err(`GitHub API returned ${res.status}`);
				return ok(`Closed #${number}`);
			} catch (e) {
				return err(`GitHub API error: ${(e as Error).message}`);
			}
		},
	};

	const addIssueComment: MagiTool = {
		name: "AddIssueComment",
		description: "Add a comment to an existing GitHub Issue.",
		parameters: Type.Object({
			number: Type.Number({ description: "Issue number" }),
			body: Type.String({ description: "Comment text (markdown supported)" }),
		}),
		async execute(_id, args) {
			const number = args.number as number;
			const body = args.body as string;
			try {
				const res = await ghFetch(
					`/repos/${GITHUB_REPO}/issues/${number}/comments`,
					{ method: "POST", body: JSON.stringify({ body }) },
				);
				if (!res.ok) return err(`GitHub API returned ${res.status}`);
				const comment = (await res.json()) as { html_url: string };
				return ok(`Comment added: ${comment.html_url}`);
			} catch (e) {
				return err(`GitHub API error: ${(e as Error).message}`);
			}
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
		listTemplateVersions,
		proposeAction,
		listIssues,
		createIssue,
		closeIssue,
		addIssueComment,
	];
}
