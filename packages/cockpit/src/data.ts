import type { FoldedTree } from "./types";

// The cockpit is served same-origin by the control plane, so the magi_session
// cookie set by the dashboard login carries auth automatically. `/missions/:id/*`
// is proxied to that mission's monitor (unreachable while suspended);
// `/api/missions/:id/*` is control-plane-native, reading Mongo directly, and
// works regardless of mission running state.

export class AuthError extends Error {}

async function api<T>(path: string): Promise<T> {
	const res = await fetch(path, {
		credentials: "include",
		headers: { Accept: "application/json" },
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
	return (await res.json()) as T;
}

/** Folded objectives tree — reads Mongo directly (ADR-0019), works while suspended. */
export function fetchObjectives(missionId: string): Promise<FoldedTree> {
	return api<FoldedTree>(
		`/api/missions/${encodeURIComponent(missionId)}/objectives`,
	);
}

export type MissionStatusValue =
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
	const res = await fetch("/api/missions", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ missionId, name, teamConfig: templateId }),
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
}

async function missionAction(missionId: string, action: string): Promise<void> {
	const res = await fetch(`/api/missions/${mp(missionId)}/${action}`, {
		method: "POST",
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
}

export const suspendMission = (missionId: string): Promise<void> =>
	missionAction(missionId, "suspend");

export const resumeMission = (missionId: string): Promise<void> =>
	missionAction(missionId, "resume");

export async function deleteMission(missionId: string): Promise<void> {
	const res = await fetch(`/api/missions/${mp(missionId)}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
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
	await fetch(`/api/missions/${encodeURIComponent(missionId)}/messages/read`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ids }),
	});
}

/** Send an operator message to one or more agents (wakes them). */
export async function sendMessage(
	missionId: string,
	to: string[],
	body: string,
	subject?: string,
): Promise<void> {
	await fetch(`/api/missions/${encodeURIComponent(missionId)}/messages/send`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to, body, subject }),
	});
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

export interface TranscriptEntry {
	callSeq: number;
	parentToolUseId: string | null;
	message: RawMessage;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface LlmCallSummary {
	index: number;
	savedAt: string;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	stopReason: string | null;
	usage: Usage | null;
	cost: { totalUsd?: number } | null;
	toolNames: string[];
	messageCount: number;
	hasBody: boolean;
}

export interface LlmCallDetail {
	index: number;
	savedAt: string;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	usage: Usage | null;
	cost: { totalUsd?: number } | null;
	input: {
		systemPrompt: string;
		messages: RawMessage[];
		toolNames: string[];
	} | null;
	output: { response: RawMessage } | null;
}

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
	await fetch(`/missions/${encodeURIComponent(missionId)}/upload`, {
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
): Promise<{ ok: boolean; commit: string | null }> {
	const res = await fetch(
		`/missions/${encodeURIComponent(missionId)}/files/shared/edit`,
		{
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path, content }),
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
	};
	agents: AgentLimitsRow[];
	/** False when suspended/provisioning/etc — live numbers are unavailable then. */
	missionRunning: boolean;
}

export function fetchLimits(missionId: string): Promise<LimitsData> {
	return api<LimitsData>(`/api/missions/${mp(missionId)}/limits`);
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
	const res = await fetch("/api/copilot/settings", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
}

export async function sendCopilotMessage(body: string): Promise<void> {
	const res = await fetch("/api/copilot/message", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subject: "Operator message", body }),
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
	await fetch("/api/copilot/dismiss", {
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
	const res = await fetch("/api/copilot/limits", {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ capUsd }),
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
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
	const res = await fetch(`/missions/${mp(missionId)}/schedule/${mp(id)}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok)
		throw new Error(`HTTP ${res.status} cancelling scheduled message`);
}

// ── Daemon log — ported from index.html's log-viewer modal ─────────────────

export async function fetchDaemonLog(
	missionId: string,
	lines = 300,
): Promise<string> {
	const res = await fetch(`/missions/${mp(missionId)}/log?lines=${lines}`, {
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching log`);
	return res.text();
}

// ── Mission/agent config editor — ported from index.html's renderConfigForm.
// ADR-0022: only mission name/model/visionModel/timezone and per-agent
// name/model/active/disabledSkills/disabledTools are editable, and only
// while the mission is suspended. Every other field (id, supervisor,
// systemPrompt, initialMentalMap, limits, linuxUser, teamFiles,
// missionCopilotLimits) must round-trip unmodified — the PUT is a full
// replace, not a per-field patch, so omitting any of them silently clears
// it server-side. The live mental map (not initialMentalMap — that's the
// template, inert after an agent's first run) is the one exception, added
// after ADR-0022: it's a separate `mentalMaps` patch, not part of `agents`,
// validated server-side against dropping a data-managed section.

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
	},
): Promise<void> {
	const res = await fetch(`/api/missions/${mp(missionId)}/config`, {
		method: "PUT",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
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
