/**
 * The copilot action registry: one typed definition per `ProposeAction`
 * type — its payload schema (strict: unknown keys are rejected), the label
 * the confirmation card shows (computed here, never LLM-written) and the
 * one-line description the LLM is given.
 *
 * Before this existed the action list lived in three places (the tool
 * description, a `VALID_TYPES` set, the `executeAction` switch) and the
 * payload was whatever the LLM passed: a skill that documented wrong keys
 * produced a pending action the operator approved from a one-line label,
 * which then inserted a malformed schedule or silently ignored the field
 * (audit EA1/EA2/SCHED3/SCFG1/CK-GATE). Now `parseActionPayload` runs when
 * the action is proposed and again when it is executed; the card shows the
 * validated payload under a server-computed label.
 */

import cronParser from "cron-parser";
import { z } from "zod";
import {
	GITHUB_ISSUE_ACTION,
	githubIssueLabel,
	parseGithubIssuePayload,
} from "./github-issues.js";

const { parseExpression } = cronParser;

const id = z.string().trim().min(1).max(200);
const OBJECT_ID_RE = /^[0-9a-f]{24}$/;

function validCron(expr: string): boolean {
	try {
		parseExpression(expr);
		return true;
	} catch {
		return false;
	}
}

const isoDate = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 date-time");

const missionOnly = z.object({ missionId: id }).strict();

export const ACTION_SCHEMAS = {
	launch_mission: z
		.object({ missionId: id, name: id.optional(), templateId: id })
		.strict(),
	launch_draft: missionOnly,
	suspend_mission: missionOnly,
	resume_mission: missionOnly,
	fix_mission_volume: missionOnly,
	write_mission_file: z
		.object({
			missionId: id,
			path: z.string().min(1).max(1024),
			content: z.string().max(4_000_000),
			agentId: id.optional(),
		})
		.strict(),
	save_session_config: z
		.object({
			missionId: id,
			mission: z.record(z.string(), z.unknown()).optional(),
			agents: z.array(z.record(z.string(), z.unknown())).optional(),
			missionCopilotLimits: z.record(z.string(), z.unknown()).optional(),
			teamFiles: z
				.array(z.object({ path: z.string(), content: z.string() }).strict())
				.optional(),
			mentalMaps: z.record(z.string(), z.string()).optional(),
		})
		.strict(),
	cancel_schedule: z
		.object({
			id: z.string().regex(OBJECT_ID_RE, "must be a 24-hex schedule id"),
		})
		.strict(),
	create_schedule: z
		.object({
			missionId: id,
			to: z.array(id).min(1).max(20),
			subject: z.string().trim().min(1).max(200),
			body: z.string().min(1).max(20_000),
			cron: z
				.string()
				.trim()
				.refine(validCron, "not a valid cron expression")
				.optional(),
			deliverAt: isoDate.optional(),
			label: z.string().trim().max(80).optional(),
		})
		.strict()
		.refine((p) => p.cron || p.deliverAt, {
			message:
				"cron or deliverAt is required (otherwise the message would be delivered immediately)",
		}),
	pause_agent: z.object({ missionId: id, agentId: id }).strict(),
	resume_agent: z.object({ missionId: id, agentId: id }).strict(),
	set_mission_budget: z
		.object({
			missionId: id,
			capUsd: z.number().finite().positive().max(100_000),
		})
		.strict(),
} as const;

export type ZodActionType = keyof typeof ACTION_SCHEMAS;
export type ActionType = ZodActionType | typeof GITHUB_ISSUE_ACTION;
export type ActionPayload<T extends ZodActionType> = z.infer<
	(typeof ACTION_SCHEMAS)[T]
>;

export const ACTION_TYPES: readonly ActionType[] = [
	...(Object.keys(ACTION_SCHEMAS) as ZodActionType[]),
	GITHUB_ISSUE_ACTION,
];

export function isActionType(t: unknown): t is ActionType {
	return typeof t === "string" && (ACTION_TYPES as string[]).includes(t);
}

/** What the LLM is told about each action — the only place these lines live. */
export const ACTION_DOCS: Record<ActionType, string> = {
	launch_mission:
		"{ missionId, name?, templateId } — create and start a mission from a template",
	launch_draft:
		"{ missionId } — validate a draft's stored config (full TeamConfig rules, unlike EditDraftConfig's permissive writes) and provision it, flipping status from draft to running; the one step that spins up a paid machine",
	suspend_mission: "{ missionId }",
	resume_mission:
		"{ missionId } — also recovers a mission whose machine was destroyed (e.g. after a prior failed resume) by reprovisioning against its volumeId; if that volume no longer exists on Fly, propose fix_mission_volume first",
	fix_mission_volume:
		"{ missionId } — for a mission whose GetMissionStatus shows its volumeId as NOT FOUND on Fly: finds the real volume by name and corrects mission.volumeId; never touches Fly itself and refuses rather than guessing. Follow with resume_mission",
	write_mission_file: "{ missionId, path, content, agentId? }",
	save_session_config:
		"{ missionId, mission?, agents?, missionCopilotLimits?, teamFiles?: [{path, content}], mentalMaps?: {[agentId]: html} } — mission must be suspended. Structured partial patch (ADR-0021): mission is shallow-merged; agents are upserted by id (reuse an id to rename; submit active: false to remove — omitting an agent does NOT delete it); missionCopilotLimits replaces wholesale; omit teamFiles to keep them (teamFiles: [] clears them). There is no teamConfigYaml field",
	cancel_schedule: "{ id } — the 24-hex id from ListSchedule",
	create_schedule:
		"{ missionId, to: [agentId…], subject, body, cron? | deliverAt?, label? } — cron (5-field, UTC) for a recurring wakeup or deliverAt (ISO date-time) for a one-off; one of them is required",
	pause_agent:
		"{ missionId, agentId } — halt one agent at its next dispatch boundary",
	resume_agent: "{ missionId, agentId } — lift a previous pause",
	set_mission_budget:
		"{ missionId, capUsd } — the mission's absolute spending cap in USD (below the operator's ceiling)",
	[GITHUB_ISSUE_ACTION]:
		"{ op: 'create', title, body, labels? } | { op: 'comment', number, body } | { op: 'close', number, comment? } — the CreateIssue/CloseIssue/AddIssueComment tools build this for you",
};

export function describeActions(): string {
	return ACTION_TYPES.map((t) => `- ${t}: ${ACTION_DOCS[t]}`).join("\n");
}

export class ActionValidationError extends Error {
	constructor(
		readonly actionType: string,
		message: string,
	) {
		super(message);
		this.name = "ActionValidationError";
	}
}

export interface ParsedAction {
	type: ActionType;
	payload: unknown;
	label: string;
}

/** Validate an LLM-supplied (or stored) action into the exact shape that will execute. Throws `ActionValidationError`. */
export function parseActionPayload(type: unknown, raw: unknown): ParsedAction {
	if (!isActionType(type)) {
		throw new ActionValidationError(
			String(type),
			`Unknown action type "${String(type)}". Valid: ${ACTION_TYPES.join(", ")}`,
		);
	}
	const payload = typeof raw === "string" ? parseJsonPayload(type, raw) : raw;
	if (type === GITHUB_ISSUE_ACTION) {
		const p = parseGithubIssuePayload(payload);
		return { type, payload: p, label: githubIssueLabel(p) };
	}
	const result = ACTION_SCHEMAS[type].safeParse(payload);
	if (!result.success) {
		const issues = result.error.issues
			.map(
				(i) =>
					`  - ${i.path.length ? i.path.join(".") : "payload"}: ${i.message}`,
			)
			.join("\n");
		throw new ActionValidationError(
			type,
			`Invalid payload for ${type}:\n${issues}\nExpected ${ACTION_DOCS[type]}`,
		);
	}
	return { type, payload: result.data, label: actionLabel(type, result.data) };
}

function parseJsonPayload(type: ActionType, raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new ActionValidationError(
			type,
			`payload for ${type} must be a JSON object, not an unparseable string`,
		);
	}
}

/** The card label, from the validated payload. */
export function actionLabel<T extends ZodActionType>(
	type: T,
	p: ActionPayload<T>,
): string {
	switch (type) {
		case "launch_mission": {
			const q = p as ActionPayload<"launch_mission">;
			return `Launch mission "${q.missionId}" from template "${q.templateId}"`;
		}
		case "launch_draft":
			return `Launch draft "${(p as ActionPayload<"launch_draft">).missionId}" (provisions a machine)`;
		case "suspend_mission":
			return `Suspend mission "${(p as ActionPayload<"suspend_mission">).missionId}"`;
		case "resume_mission":
			return `Resume mission "${(p as ActionPayload<"resume_mission">).missionId}"`;
		case "fix_mission_volume":
			return `Correct the volumeId of mission "${(p as ActionPayload<"fix_mission_volume">).missionId}" from Fly`;
		case "write_mission_file": {
			const q = p as ActionPayload<"write_mission_file">;
			return `Write ${q.path} (${q.content.length} chars) in mission "${q.missionId}"${q.agentId ? ` as ${q.agentId}` : ""}`;
		}
		case "save_session_config": {
			const q = p as ActionPayload<"save_session_config">;
			const parts = (
				[
					"mission",
					"agents",
					"missionCopilotLimits",
					"teamFiles",
					"mentalMaps",
				] as const
			).filter((k) => q[k] !== undefined);
			return `Save config of mission "${q.missionId}" (${parts.length ? parts.join(", ") : "no fields"})`;
		}
		case "cancel_schedule":
			return `Cancel scheduled message ${(p as ActionPayload<"cancel_schedule">).id}`;
		case "create_schedule": {
			const q = p as ActionPayload<"create_schedule">;
			const when = q.cron ? `cron ${q.cron}` : `at ${q.deliverAt}`;
			return `Schedule "${q.subject}" → ${q.to.join(", ")} in mission "${q.missionId}" (${when})`;
		}
		case "pause_agent": {
			const q = p as ActionPayload<"pause_agent">;
			return `Pause agent "${q.agentId}" in mission "${q.missionId}"`;
		}
		case "resume_agent": {
			const q = p as ActionPayload<"resume_agent">;
			return `Resume agent "${q.agentId}" in mission "${q.missionId}"`;
		}
		case "set_mission_budget": {
			const q = p as ActionPayload<"set_mission_budget">;
			return `Set the spend cap of mission "${q.missionId}" to $${q.capUsd.toFixed(2)}`;
		}
	}
	// Exhaustive above; TypeScript cannot see it through the generic.
	return `${type}`;
}
