import type {
	LlmCallDetail,
	LlmCallSummary,
	TranscriptEntry,
} from "./llm-call-types.js";
import type { FoldedTree } from "./types";

// The cockpit is served same-origin by the control plane, so the magi_session
// cookie set by the dashboard login carries auth automatically. `/missions/:id/*`
// is proxied to that mission's monitor (unreachable while suspended);
// `/api/missions/:id/*` is control-plane-native, reading Mongo directly, and
// works regardless of mission running state.

/** 401: no usable session — the app shows the login screen. */
export class AuthError extends Error {}
/** 403: signed in, but this action is refused (cap above the ceiling, disabled route, not the owner). Shown, never treated as signed-out. */
export class ForbiddenError extends Error {}

async function errorText(res: Response, path: string): Promise<string> {
	const body = (await res
		.clone()
		.json()
		.catch(() => null)) as { error?: string } | null;
	return body?.error ?? `HTTP ${res.status} for ${path}`;
}

/**
 * Every cockpit call goes through here so the status mapping exists once:
 * 401 → AuthError, 403 → ForbiddenError with the server's message, any other
 * non-2xx → Error with the server's message. Callers never see a failed
 * response as success.
 */
export async function request(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const res = await fetch(path, {
		credentials: "include",
		...init,
		headers: { Accept: "application/json", ...(init.headers ?? {}) },
	});
	if (res.status === 401) throw new AuthError("not signed in");
	if (res.status === 403) throw new ForbiddenError(await errorText(res, path));
	if (!res.ok) throw new Error(await errorText(res, path));
	return res;
}

async function api<T>(path: string): Promise<T> {
	return (await (await request(path)).json()) as T;
}

/** Folded objectives tree — reads Mongo directly (ADR-0019), works while suspended. */
export function fetchObjectives(missionId: string): Promise<FoldedTree> {
	return api<FoldedTree>(
		`/api/missions/${encodeURIComponent(missionId)}/objectives`,
	);
}

export type MissionStatusValue =
	| "draft"
	| "provisioning"
	| "running"
	| "suspended"
	| "destroyed"
	| "error";

export interface MissionSummary {
	missionId: string;
	name: string;
	status: MissionStatusValue;
	createdAt: string;
	errorMessage?: string;
	/** GET /api/missions returns the full stored doc (no projection) — mission.maxCostUsd rides along for free. */
	mission?: { maxCostUsd?: number | null };
}

/** The current user's missions (for the picker when no ?mission is given). */
export function fetchMissions(): Promise<MissionSummary[]> {
	return api<MissionSummary[]>("/api/missions");
}

/** Launches a mission from a template. Returns the created mission's id. */
export async function createMission(
	missionId: string,
	name: string,
	templateId: string,
): Promise<void> {
	await request("/api/missions", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ missionId, name, teamConfig: templateId }),
	});
}

async function missionAction(missionId: string, action: string): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/${action}`, {
		method: "POST",
		credentials: "include",
	});
}

export const suspendMission = (missionId: string): Promise<void> =>
	missionAction(missionId, "suspend");

export const resumeMission = (missionId: string): Promise<void> =>
	missionAction(missionId, "resume");

export async function deleteMission(missionId: string): Promise<void> {
	await request(`/api/missions/${mp(missionId)}`, {
		method: "DELETE",
		credentials: "include",
	});
}

// ── Mission-prep drafts ──────────────────────────────────────────────────────
// A draft is a MissionDoc like any other (status: "draft", no machine yet) —
// see docs/adr/0021 and the PUT /:id/draft route comment in missions.ts for
// why draft saves skip parseTeamConfig (a blank/in-progress roster would
// always fail it) while GET /:id/config, reused unchanged below, already
// works for a draft since it only requires mission.mission/agents to exist.

/** Creates a draft mission — cloned from a template, or blank if templateId is omitted. */
export async function createDraft(
	missionId: string,
	name: string,
	templateId?: string,
): Promise<void> {
	await request("/api/missions/draft", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ missionId, name, teamConfig: templateId }),
	});
}

/** Full-replace save of a draft's config — permissive, no validation (see PUT /:id/draft). */
export async function saveDraftConfig(
	missionId: string,
	payload: {
		mission: MissionConfigMission;
		agents: MissionConfigAgent[];
		missionCopilotLimits?: unknown;
		teamFiles: Array<{ path: string; content: string }>;
	},
): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/draft`, {
		method: "PUT",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

/**
 * Validates a draft's stored config (full TeamConfig rules) and provisions it.
 * Throws with the server's real error text on failure — e.g. a 400 naming the
 * exact missing field, surfaced verbatim in the Draft Editor's error banner.
 */
export async function launchDraft(missionId: string): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/launch`, {
		method: "POST",
		credentials: "include",
	});
}

// ── Templates (read-only, disk-only — ADR-0021/0022) ────────────────────────

export interface TemplateSummary {
	id: string;
	name: string;
}

export interface TemplateDetail {
	id: string;
	name: string;
	config: {
		mission: { id: string; name: string; model?: string };
		agents: Array<{
			id: string;
			name?: string;
			role?: string;
			supervisor: string;
		}>;
	};
	teamFiles: Array<{ path: string; content: string }>;
}

export function fetchTemplates(): Promise<TemplateSummary[]> {
	return api<TemplateSummary[]>("/api/templates");
}

export function fetchTemplate(id: string): Promise<TemplateDetail> {
	return api<TemplateDetail>(`/api/templates/${mp(id)}`);
}

export interface ConvMessage {
	id: string;
	from: string;
	to: string[];
	subject: string;
	body: string;
	timestamp: string;
	read: boolean;
}

/** Every mailbox message the operator is part of (sender or recipient). */
export function fetchConversations(missionId: string): Promise<ConvMessage[]> {
	return api<ConvMessage[]>(
		`/api/missions/${encodeURIComponent(missionId)}/conversations`,
	);
}

export interface Agent {
	id: string;
	name: string;
}

/** The mission's agent roster (for the compose recipient chips). */
export function fetchAgents(missionId: string): Promise<Agent[]> {
	return api<Agent[]>(`/api/missions/${encodeURIComponent(missionId)}/agents`);
}

/** Mark operator-addressed messages read. */
export async function markMessagesRead(
	missionId: string,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;
	await request(
		`/api/missions/${encodeURIComponent(missionId)}/messages/read`,
		{
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids }),
		},
	);
}

/** Send an operator message to one or more agents (wakes them). */
export async function sendMessage(
	missionId: string,
	to: string[],
	body: string,
	subject?: string,
): Promise<void> {
	await request(
		`/api/missions/${encodeURIComponent(missionId)}/messages/send`,
		{
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to, body, subject }),
		},
	);
}

// ── Transcript + LLM-log explorer ───────────────────────────────────────────

export interface TurnSummary {
	turnNumber: number;
	startedAt: string;
	completedAt: string | null;
	status: string;
	llmCallCount: number;
	costUsd: number;
	peakContextTokens: number;
	toolCalls: Record<string, number>;
	toolErrors: Record<string, number>;
}

/** A pi-ai message, rendered defensively (shape varies by role/provider). */
export interface RawMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	stopReason?: string;
	[k: string]: unknown;
}

export type {
	LlmCallDetail,
	LlmCallSummary,
	TranscriptEntry,
	Usage,
} from "./llm-call-types.js";

const mp = (id: string) => encodeURIComponent(id);

export function fetchTurns(
	missionId: string,
	agentId: string,
): Promise<TurnSummary[]> {
	return api<TurnSummary[]>(
		`/api/missions/${mp(missionId)}/turns?agent=${mp(agentId)}`,
	);
}

export function fetchTranscript(
	missionId: string,
	agentId: string,
	turn: number,
): Promise<TranscriptEntry[]> {
	return api<TranscriptEntry[]>(
		`/api/missions/${mp(missionId)}/transcript?agent=${mp(agentId)}&turn=${turn}`,
	);
}

export function fetchLlmCalls(
	missionId: string,
	agentId: string,
	turn: number,
): Promise<LlmCallSummary[]> {
	return api<LlmCallSummary[]>(
		`/api/missions/${mp(missionId)}/llm-calls?agent=${mp(agentId)}&turn=${turn}`,
	);
}

export function fetchLlmCall(
	missionId: string,
	agentId: string,
	turn: number,
	i: number,
): Promise<LlmCallDetail> {
	return api<LlmCallDetail>(
		`/api/missions/${mp(missionId)}/llm-call?agent=${mp(agentId)}&turn=${turn}&i=${i}`,
	);
}

function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			resolve(result.slice(result.indexOf(",") + 1)); // strip the data: prefix
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/**
 * Attach a file to a message to one or more agents. Routes through the mission
 * monitor's upload pipeline (proxied): the file is saved and processed into an
 * artifact ONCE, and a single mailbox message to all recipients points at it.
 */
export async function uploadAttachment(
	missionId: string,
	to: string[],
	file: File,
	body: string,
): Promise<void> {
	const contentBase64 = await fileToBase64(file);
	await request(`/missions/${encodeURIComponent(missionId)}/upload`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			filename: file.name,
			agentIds: to,
			contentBase64,
			mimeType: file.type || undefined,
			subject: "Operator attachment",
			body,
		}),
	});
}

// ── Files panel (workspace browser) ─────────────────────────────────────────

export interface DirEntry {
	name: string;
	type: "dir" | "file";
	size?: number;
	modified?: string;
}

export type FileNode =
	| { type: "dir"; path: string; entries: DirEntry[] }
	| {
			type: "file";
			name: string;
			encoding: "text" | "base64" | "binary";
			mimeType?: string;
			content?: string;
			truncated?: boolean;
	  };

/** Browse a directory or read a file from the mission's shared workspace. */
export function fetchFileNode(
	missionId: string,
	path: string,
): Promise<FileNode> {
	return api<FileNode>(
		`/missions/${encodeURIComponent(missionId)}/files/shared?path=${encodeURIComponent(path)}`,
	);
}

export interface FileHistoryEntry {
	commit: string;
	timestamp: string;
	agentId: string | null;
	turnNumber: number | null;
}

/** Git provenance for a file — most recent commit first. */
export function fetchFileHistory(
	missionId: string,
	path: string,
): Promise<FileHistoryEntry[]> {
	return api<FileHistoryEntry[]>(
		`/missions/${encodeURIComponent(missionId)}/files/history?path=${encodeURIComponent(path)}`,
	);
}

/** Direct-download URL (file, or a folder as a zip) — for a plain <a href>. */
export function fileDownloadUrl(missionId: string, path: string): string {
	return `/missions/${encodeURIComponent(missionId)}/download?path=${encodeURIComponent(path)}`;
}

/**
 * Save an edited text file back to the mission's shared workspace. Commits
 * immediately and notifies the file's last-touching agent server-side (see
 * monitor-server.ts's handleFileEdit) — this call is fire-and-check, not a
 * two-step process. Only works while the mission is running (files live on
 * the Fly volume); the proxy returns 503 otherwise, surfaced here as a thrown
 * Error for the caller to display without losing the operator's edit.
 */
export async function saveFile(
	missionId: string,
	path: string,
	content: string,
	/** The file's last commit as loaded; the server refuses (409) when it has moved. Null = no check. */
	expectedHead: string | null = null,
): Promise<{ ok: boolean; commit: string | null }> {
	const res = await fetch(
		`/missions/${encodeURIComponent(missionId)}/files/shared/edit`,
		{
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path,
				content,
				...(expectedHead ? { expectedHead } : {}),
			}),
		},
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(body?.error ?? `HTTP ${res.status} saving ${path}`);
	}
	return (await res.json()) as { ok: boolean; commit: string | null };
}

// ── Trace panel (mission-wide cost + interaction overview) ─────────────────

export interface AgentMissionStats {
	agentId: string;
	lifetimeCostUsd: number;
	lifetimeLlmCallCount: number;
	lifetimeTurnCount: number;
}

/** Lifetime cost/calls/turns per agent for the whole mission. */
export function fetchMissionStats(
	missionId: string,
): Promise<AgentMissionStats[]> {
	return api<AgentMissionStats[]>(
		`/missions/${encodeURIComponent(missionId)}/mission-stats`,
	);
}

export interface TurnCost {
	agentId: string;
	turnNumber: number;
	startedAt: string;
	completedAt: string;
	costUsd: number;
	llmCallCount: number;
	peakContextTokens: number;
	status: "running" | "complete" | "aborted";
	gitChangedFiles?: { path: string; status: string }[];
}

/**
 * Per-agent per-turn stats, for the cost-over-time chart and its turn/file/
 * anomaly markers. Only finalized turns (with a settled cost + duration) are
 * returned.
 */
export function fetchCostSeries(missionId: string): Promise<TurnCost[]> {
	return api<TurnCost[]>(
		`/missions/${encodeURIComponent(missionId)}/cost-series`,
	);
}

export interface Interaction {
	from: string;
	to: string;
	count: number;
}

/** Message counts between every pair of senders/recipients in the mailbox. */
export function fetchInteractions(missionId: string): Promise<Interaction[]> {
	return api<Interaction[]>(
		`/missions/${encodeURIComponent(missionId)}/interactions`,
	);
}

export interface MessageEvent {
	from: string;
	to: string[];
	subject: string;
	timestamp: string;
}

/** Every mailbox message in the mission, timestamped, for the Trace markers. */
export function fetchMessageEvents(missionId: string): Promise<MessageEvent[]> {
	return api<MessageEvent[]>(
		`/missions/${encodeURIComponent(missionId)}/message-events`,
	);
}

// ── Limits panel (budget/limits vs. current consumption) ────────────────────
// Control-plane-native routes (/api/missions/:id/...), not monitor-proxied —
// these read/write teamConfigYaml directly via MongoDB, so they work
// regardless of whether the mission is currently running.

export interface AgentLimits {
	maxLlmCallsPerTurn?: number;
	maxCostPerTurnUsd?: number;
	maxLifetimeCostUsd?: number;
	warnLlmCallsPerTurn?: number;
	warnPeakContextTokens?: number;
	warnToolErrorsPerTurn?: number;
	warnConsecutiveZeroOutputTurns?: number;
}

export interface AgentLimitsRow {
	agentId: string;
	limits: AgentLimits;
	/** Configured value, else the built-in soft default — always populated. */
	effectiveSoft: Required<
		Pick<
			AgentLimits,
			| "warnLlmCallsPerTurn"
			| "warnPeakContextTokens"
			| "warnToolErrorsPerTurn"
			| "warnConsecutiveZeroOutputTurns"
		>
	>;
	live: {
		lifetimeCostUsd: number | null;
		lifetimeLlmCallCount: number | null;
		consecutiveZeroOutputTurns: number | null;
		/** Turn-scoped hard/soft limits can only be compared against the most
		 * recently completed turn — no route exposes a genuinely in-progress one. */
		mostRecentTurn: {
			turnNumber: number;
			llmCallCount: number;
			costUsd: number;
			peakContextTokens: number;
			toolErrorsTotal: number;
		} | null;
	};
}

export interface LimitsData {
	mission: {
		maxCostUsd: number | null;
		missionTotalUsd: number | null;
		budgetPaused: boolean | null;
		/** Issue #49 / F-025 — operator-only ceiling on the spend cap above;
		 * null means none configured (unbounded, legacy default). No mission
		 * tool can ever raise this — only the cockpit Limits panel can. */
		maxCostCeilingUsd: number | null;
	};
	agents: AgentLimitsRow[];
	/** False when suspended/provisioning/etc — live numbers are unavailable then. */
	missionRunning: boolean;
	/** Temporary machine upgrades (ADR-0031 Decision 7). */
	upgrades: {
		usedHours: number;
		capHours: number;
		/** ISO timestamp of the operator's last reset, or null if never reset. */
		resetAt: string | null;
		active: {
			cpuKind: string;
			cpus: number;
			memoryMb: number;
			expiresAt: string;
			requestedByAgentId?: string;
		} | null;
	};
}

// ── Runtime tab (ADR-0031) — machine time by config, not $ spend ──────────

export interface MachineRuntimeRow {
	shape: { cpuKind: string; cpus: number; memoryMb: number };
	upgraded: boolean;
	ms: number;
	/** Display-only estimate from the static price table — never enforcement. */
	estimatedCostUsd: number;
}

export interface MachineRuntimeData {
	byHorizon: Record<"today" | "7d" | "30d" | "lifetime", MachineRuntimeRow[]>;
}

export function fetchMachineRuntime(
	missionId: string,
): Promise<MachineRuntimeData> {
	return api<MachineRuntimeData>(
		`/api/missions/${mp(missionId)}/machine-runtime`,
	);
}

export function fetchLimits(missionId: string): Promise<LimitsData> {
	return api<LimitsData>(`/api/missions/${mp(missionId)}/limits`);
}

/** Issue #31/ADR-0031 — resets the cumulative upgraded-machine-runtime cap to
 * 0. No mission tool can ever call this route; only the cockpit Limits panel
 * can, matching the same structural-separation pattern as
 * saveMissionCostCeiling (see missions.ts's writeUpgradedRuntimeReset). */
export async function resetUpgradedRuntime(
	missionId: string,
): Promise<{ resetAt: string }> {
	const res = await fetch(
		`/api/missions/${mp(missionId)}/limits/upgrade-reset`,
		{
			method: "PATCH",
			credentials: "include",
		},
	);
	if (!res.ok) throw new Error(`HTTP ${res.status} resetting upgraded runtime`);
	return (await res.json()) as { resetAt: string };
}

/** Returns whether the mission's own live cap was also updated immediately
 * (only possible while running) — the persisted write always succeeds
 * regardless, and is what survives a future resume either way. */
export async function saveMissionCap(
	missionId: string,
	maxCostUsd: number,
): Promise<{ liveUpdateApplied: boolean }> {
	const res = await fetch(`/api/missions/${mp(missionId)}/limits/mission`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ maxCostUsd }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} saving mission cap`);
	return (await res.json()) as { liveUpdateApplied: boolean };
}

/** Issue #49 / F-025 — sets the operator-only spend-cap ceiling. No mission
 * tool (SetMissionSpendCap, SaveMissionConfig) can ever call this route or
 * raise this value; only the cockpit Limits panel can, matching the fact
 * that maxCostCeilingUsd is a structurally separate field from the writer
 * those tools share (see missions.ts's writeMissionCostCeiling). */
export async function saveMissionCostCeiling(
	missionId: string,
	ceilingUsd: number,
): Promise<{ maxCostCeilingUsd: number }> {
	const res = await fetch(`/api/missions/${mp(missionId)}/limits/ceiling`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ceilingUsd }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} saving spend-cap ceiling`);
	return (await res.json()) as { maxCostCeilingUsd: number };
}

/** `limits: null` clears every configured limit for that agent. Takes effect
 * the next time the mission is resumed, not immediately. */
export async function saveAgentLimits(
	missionId: string,
	agentId: string,
	limits: AgentLimits | null,
): Promise<void> {
	const res = await fetch(
		`/api/missions/${mp(missionId)}/limits/agent/${mp(agentId)}`,
		{
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ limits }),
		},
	);
	if (!res.ok) throw new Error(`HTTP ${res.status} saving agent limits`);
}

// ── Standalone copilot chat — cross-mission, control-plane-native ──────────
// Ports index.html's copilot pane (lines ~339-360, ~1342-1607) to the cockpit.

export interface CopilotHistoryEntry {
	role: "user" | "assistant";
	body: string;
	subject: string;
	timestamp: string;
}

export function fetchCopilotHistory(): Promise<CopilotHistoryEntry[]> {
	return api<CopilotHistoryEntry[]>("/api/copilot/history");
}

export interface CopilotPendingAction {
	id: string;
	type: string;
	label: string;
	payload?: unknown;
	createdAt: string;
}

/** Cards still awaiting confirmation — persisted server-side, so a reload or a control-plane restart does not lose them. */
export async function fetchCopilotPendingActions(): Promise<
	CopilotPendingAction[]
> {
	const r = await api<{ actions: CopilotPendingAction[] }>(
		"/api/copilot/pending",
	);
	return r.actions;
}

export interface CopilotUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	costUsd: number;
}

export function fetchCopilotUsage(): Promise<CopilotUsage> {
	return api<CopilotUsage>("/api/copilot/usage");
}

export interface CopilotSettings {
	model: string;
	isDefault: boolean;
}

export function fetchCopilotSettings(): Promise<CopilotSettings> {
	return api<CopilotSettings>("/api/copilot/settings");
}

/** Throws with the server's real error text on failure (e.g. a 409 while a turn is in flight). */
export async function saveCopilotSettings(model: string | null): Promise<void> {
	await request("/api/copilot/settings", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
	});
}

/** Throws with the server's real error text on failure (e.g. a 402 naming the exact spend cap reached). */
export async function sendCopilotMessage(body: string): Promise<void> {
	const res = await request("/api/copilot/message", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subject: "Operator message", body }),
	});
	if (!res.ok) {
		const errBody = await res.json().catch(() => null);
		throw new Error(
			(errBody as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
}

export async function confirmCopilotAction(
	pendingActionId: string,
): Promise<{ result?: string; error?: string }> {
	const res = await fetch("/api/copilot/confirm", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pendingActionId }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		return {
			error: (body as { error?: string }).error ?? `HTTP ${res.status}`,
		};
	}
	return { result: (body as { result?: string }).result };
}

export async function dismissCopilotAction(
	pendingActionId: string,
): Promise<void> {
	await request("/api/copilot/dismiss", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pendingActionId }),
	});
}

// ── Copilot visibility — transcripts, files, spend-cap limits ──────────────
// Same response shapes as the mission Transcripts/Files/Limits routes (reusing
// those types below), but scoped by the caller's own session — no missionId/
// agentId params, since there's exactly one copilot per user.

export function fetchCopilotTurns(): Promise<TurnSummary[]> {
	return api<TurnSummary[]>("/api/copilot/turns");
}

export function fetchCopilotTranscript(
	turn: number,
): Promise<TranscriptEntry[]> {
	return api<TranscriptEntry[]>(`/api/copilot/transcript?turn=${turn}`);
}

export function fetchCopilotLlmCalls(turn: number): Promise<LlmCallSummary[]> {
	return api<LlmCallSummary[]>(`/api/copilot/llm-calls?turn=${turn}`);
}

export function fetchCopilotLlmCall(
	turn: number,
	i: number,
): Promise<LlmCallDetail> {
	return api<LlmCallDetail>(`/api/copilot/llm-call?turn=${turn}&i=${i}`);
}

export function fetchCopilotFileNode(path: string): Promise<FileNode> {
	return api<FileNode>(`/api/copilot/files?path=${encodeURIComponent(path)}`);
}

export interface CopilotLimits {
	capUsd: number | null;
	spentUsd: number;
}

export function fetchCopilotLimits(): Promise<CopilotLimits> {
	return api<CopilotLimits>("/api/copilot/limits");
}

export async function saveCopilotLimits(capUsd: number | null): Promise<void> {
	await request("/api/copilot/limits", {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ capUsd }),
	});
}

// ── Scheduled wake-ups — ported from the mission-local dashboard's Schedule
// tab (agent-runtime-worker/public/app.js), which has no cockpit surface.

export interface ScheduledMessage {
	id: string;
	to: string[];
	subject: string;
	cronExpression: string | null;
	scheduledFor: string | null;
}

export function fetchSchedule(missionId: string): Promise<ScheduledMessage[]> {
	return api<ScheduledMessage[]>(`/missions/${mp(missionId)}/schedule`);
}

export async function cancelScheduledMessage(
	missionId: string,
	id: string,
): Promise<void> {
	const res = await request(`/missions/${mp(missionId)}/schedule/${mp(id)}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok)
		throw new Error(`HTTP ${res.status} cancelling scheduled message`);
}

// ── Daemon log — ported from index.html's log-viewer modal ─────────────────

export async function fetchDaemonLog(
	missionId: string,
	lines = 300,
): Promise<string> {
	const res = await request(`/missions/${mp(missionId)}/log?lines=${lines}`, {
		credentials: "include",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching log`);
	return res.text();
}

// ── Mission/agent config editor — ported from index.html's renderConfigForm.
// Editable, only while the mission is suspended: mission
// name/model/visionModel/timezone, per-agent name/model/active/
// disabledSkills/disabledTools/supervisor/systemPrompt, and the live mental
// map. Every other field (id, initialMentalMap post-launch — that's the
// template, inert after an agent's first run — limits, linuxUser, teamFiles,
// missionCopilotLimits) must round-trip unmodified — the PUT is a full
// replace, not a per-field patch, so omitting any of them silently clears it
// server-side. supervisor/systemPrompt were mission-copilot-only under
// ADR-0022's original decision; the ADR now gives the operator direct
// control instead. The live mental map is a separate `mentalMaps` patch, not
// part of `agents`, validated server-side against dropping a data-managed
// section (ADR-0022's "Post-ADR-0022 addendum").

export interface MissionConfigAgent {
	id: string;
	name?: string;
	role?: string;
	supervisor: string;
	systemPrompt: string;
	initialMentalMap: string;
	model?: string;
	active?: boolean;
	disabledSkills?: string[];
	disabledTools?: string[];
	[key: string]: unknown;
}

export interface MissionConfigMission {
	id: string;
	name: string;
	model?: string;
	visionModel?: string;
	timezone?: string;
	[key: string]: unknown;
}

export interface MissionConfigData {
	mission: MissionConfigMission;
	agents: MissionConfigAgent[];
	missionCopilotLimits?: unknown;
	teamFiles: Array<{ path: string; content: string }>;
	mentalMaps: Record<string, string>;
	/**
	 * The mission copilot isn't in `agents` (injected in-memory only, ADR-0016),
	 * and its systemPrompt/initialMentalMap aren't stored fields — both are
	 * synthesized fresh every session from a fixed platform template plus this
	 * mission's own name/roster. Read-only display only; nothing to save back.
	 * Its live mental map (if it has run) is under `mentalMaps["mission-copilot"]`,
	 * same as any other agent.
	 */
	missionCopilot: { systemPrompt: string; initialMentalMap: string };
}

export function fetchMissionConfig(
	missionId: string,
): Promise<MissionConfigData> {
	return api<MissionConfigData>(`/api/missions/${mp(missionId)}/config`);
}

/** Throws with the server's real error text on failure (e.g. 409 while not suspended). */
export async function saveMissionConfig(
	missionId: string,
	payload: {
		mission: MissionConfigMission;
		agents: MissionConfigAgent[];
		missionCopilotLimits: unknown;
		teamFiles: Array<{ path: string; content: string }>;
		/** agentId -> full replacement HTML, including "mission-copilot" if edited. */
		mentalMaps?: Record<string, string>;
		/** The document's updatedAt when the form was loaded; the server refuses (409) if it has moved. */
		expectedUpdatedAt?: string;
	},
): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/config`, {
		method: "PUT",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

/** Just the fields the config editor needs to know whether editing is allowed right now. */
export async function fetchMissionStatus(
	missionId: string,
): Promise<MissionStatusValue> {
	const m = await api<{ status: MissionStatusValue }>(
		`/api/missions/${mp(missionId)}`,
	);
	return m.status;
}

/**
 * Cheap staleness check for the Draft Editor's poll — a draft has no
 * machineId, so GET /:id never attempts a live Fly lookup for one, making
 * this call fast enough to poll every few seconds.
 */
export async function fetchMissionUpdatedAt(
	missionId: string,
): Promise<string> {
	const m = await api<{ updatedAt: string }>(`/api/missions/${mp(missionId)}`);
	return m.updatedAt;
}

/** The mission's display name, for the per-mission dashboard header. */
export async function fetchMissionName(missionId: string): Promise<string> {
	const m = await api<{ name: string }>(`/api/missions/${mp(missionId)}`);
	return m.name;
}

// ── Cross-mission stats — ported from index.html's Active Sessions cards ───

export interface MissionStatsEntry {
	unread: number;
	spendTotal: number;
	spendToday: number;
	spendLastHour: number;
	lastActivity: string | null;
	snippet: string | null;
}

export function fetchMissionsStats(): Promise<
	Record<string, MissionStatsEntry>
> {
	return api<Record<string, MissionStatsEntry>>("/api/missions/stats");
}
