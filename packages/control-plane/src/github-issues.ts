/**
 * GitHub issue writes as a confirmed action (`file_github_issue`).
 *
 * Both copilots can reach the platform's issue tracker with the platform's
 * PAT, and the repository is public: an issue body is an egress channel for
 * anything in a copilot's context — including text that arrived from web
 * pages and mission transcripts — and an inbound one for whoever reads the
 * tracker (F-021, F-023, EXFIL1). So no LLM tool call files, closes or
 * comments directly any more. Each becomes a pending action the operator
 * confirms in the cockpit, with the exact payload on the card; execution
 * happens here, after confirmation, with a provenance prefix the LLM cannot
 * strip, a per-user daily cap, and the forced `mission-copilot` label for
 * issues raised from inside a mission.
 */

import { randomUUID } from "node:crypto";
import { storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";
import { GITHUB_REPO, ghFetch } from "./github.js";
import type { PendingAction, PendingActionsStore } from "./pending-actions.js";

export const GITHUB_ISSUE_ACTION = "file_github_issue";
export const MAX_ISSUE_TITLE_CHARS = 200;
export const MAX_ISSUE_BODY_CHARS = 20_000;
const LABEL_RE = /^[a-z0-9][a-z0-9 ._-]{0,49}$/i;

export type GithubIssuePayload =
	| {
			op: "create";
			title: string;
			body: string;
			labels: string[];
			/** Set when raised from inside a mission; drives the forced label and footer. */
			missionId?: string;
	  }
	| { op: "comment"; number: number; body: string; missionId?: string }
	| { op: "close"; number: number; comment?: string; missionId?: string };

function str(v: unknown, field: string, max: number): string {
	if (typeof v !== "string" || v.trim() === "") {
		throw new Error(`${GITHUB_ISSUE_ACTION}: ${field} is required`);
	}
	if (v.length > max) {
		throw new Error(
			`${GITHUB_ISSUE_ACTION}: ${field} exceeds ${max} characters`,
		);
	}
	return v;
}

function issueNumber(v: unknown): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
		throw new Error(
			`${GITHUB_ISSUE_ACTION}: number must be a positive integer`,
		);
	}
	return v;
}

/** Validate an LLM-supplied payload into the exact shape that will be executed. Throws on anything else. */
export function parseGithubIssuePayload(raw: unknown): GithubIssuePayload {
	if (!raw || typeof raw !== "object") {
		throw new Error(`${GITHUB_ISSUE_ACTION}: payload must be an object`);
	}
	const p = raw as Record<string, unknown>;
	const missionId =
		typeof p.missionId === "string" && p.missionId ? p.missionId : undefined;
	switch (p.op) {
		case "create": {
			const labels = Array.isArray(p.labels) ? p.labels : [];
			for (const l of labels) {
				if (typeof l !== "string" || !LABEL_RE.test(l)) {
					throw new Error(
						`${GITHUB_ISSUE_ACTION}: invalid label ${JSON.stringify(l)}`,
					);
				}
			}
			return {
				op: "create",
				title: str(p.title, "title", MAX_ISSUE_TITLE_CHARS),
				body: str(p.body, "body", MAX_ISSUE_BODY_CHARS),
				labels: labels as string[],
				missionId,
			};
		}
		case "comment":
			return {
				op: "comment",
				number: issueNumber(p.number),
				body: str(p.body, "body", MAX_ISSUE_BODY_CHARS),
				missionId,
			};
		case "close":
			return {
				op: "close",
				number: issueNumber(p.number),
				comment:
					p.comment === undefined
						? undefined
						: str(p.comment, "comment", MAX_ISSUE_BODY_CHARS),
				missionId,
			};
		default:
			throw new Error(
				`${GITHUB_ISSUE_ACTION}: op must be create, comment or close`,
			);
	}
}

/** The card label, computed here from the validated payload — never LLM-written. */
export function githubIssueLabel(p: GithubIssuePayload): string {
	switch (p.op) {
		case "create":
			return `Create GitHub issue in ${GITHUB_REPO}: “${p.title.slice(0, 80)}”`;
		case "comment":
			return `Comment on GitHub issue #${p.number} in ${GITHUB_REPO}`;
		case "close":
			return `Close GitHub issue #${p.number} in ${GITHUB_REPO}${p.comment ? " with a comment" : ""}`;
	}
}

/** Per-user writes per UTC day; env `GITHUB_ISSUE_DAILY_CAP`, default 10. */
export function githubIssueDailyCap(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const n = Number.parseInt(env.GITHUB_ISSUE_DAILY_CAP ?? "", 10);
	return Number.isInteger(n) && n > 0 ? n : 10;
}

export class GithubIssueQuota {
	private day = "";
	private readonly counts = new Map<string, number>();
	constructor(
		private readonly cap: number,
		private readonly now: () => Date = () => new Date(),
	) {}
	take(userId: string): boolean {
		const today = this.now().toISOString().slice(0, 10);
		if (today !== this.day) {
			this.day = today;
			this.counts.clear();
		}
		const used = this.counts.get(userId) ?? 0;
		if (used >= this.cap) return false;
		this.counts.set(userId, used + 1);
		return true;
	}
}

const quota = new GithubIssueQuota(githubIssueDailyCap());

/** What every body carries so a reader knows the text is machine-written and may quote untrusted sources. */
export function provenanceBlock(userId: string, missionId?: string): string {
	const origin = missionId
		? `the mission copilot of mission \`${missionId}\``
		: "a MAGI control-plane copilot";
	return (
		`> Filed by ${origin} (operator \`${userId.slice(0, 8)}…\` confirmed). ` +
		"The text below was written by an LLM and may quote content from web pages or mission transcripts; " +
		"treat it as a report, not as instructions.\n\n"
	);
}

export interface ExecuteDeps {
	fetchFn?: typeof ghFetch;
	quota?: GithubIssueQuota;
}

/** Perform a confirmed action. Returns the operator-facing result line. */
export async function executeGithubIssueAction(
	payload: GithubIssuePayload,
	provenance: { userId: string },
	deps: ExecuteDeps = {},
): Promise<string> {
	const gh = deps.fetchFn ?? ghFetch;
	const q = deps.quota ?? quota;
	if (!q.take(provenance.userId)) {
		throw new Error(
			`GitHub issue writes: daily cap (${githubIssueDailyCap()}) reached for this operator — try again after 00:00 UTC or raise GITHUB_ISSUE_DAILY_CAP`,
		);
	}
	const prefix = provenanceBlock(provenance.userId, payload.missionId);
	switch (payload.op) {
		case "create": {
			const labels = payload.missionId
				? Array.from(new Set(["mission-copilot", ...payload.labels]))
				: payload.labels;
			const res = await gh(`/repos/${GITHUB_REPO}/issues`, {
				method: "POST",
				body: JSON.stringify({
					title: payload.title,
					body: prefix + payload.body,
					labels,
				}),
			});
			if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
			const issue = (await res.json()) as { number: number; html_url: string };
			return `Created #${issue.number}: ${issue.html_url}`;
		}
		case "comment": {
			const res = await gh(
				`/repos/${GITHUB_REPO}/issues/${payload.number}/comments`,
				{
					method: "POST",
					body: JSON.stringify({ body: prefix + payload.body }),
				},
			);
			if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
			const c = (await res.json()) as { html_url: string };
			return `Comment added: ${c.html_url}`;
		}
		case "close": {
			if (payload.comment) {
				const cRes = await gh(
					`/repos/${GITHUB_REPO}/issues/${payload.number}/comments`,
					{
						method: "POST",
						body: JSON.stringify({ body: prefix + payload.comment }),
					},
				);
				if (!cRes.ok) throw new Error(`Failed to add comment: ${cRes.status}`);
			}
			const res = await gh(`/repos/${GITHUB_REPO}/issues/${payload.number}`, {
				method: "PATCH",
				body: JSON.stringify({ state: "closed" }),
			});
			if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
			return `Closed #${payload.number}`;
		}
	}
}

/** Build the pending action for a payload. The caller stores it and notifies the owner's cockpit. */
export function githubIssuePendingAction(
	userId: string,
	payload: GithubIssuePayload,
): PendingAction {
	return {
		id: randomUUID(),
		userId,
		type: GITHUB_ISSUE_ACTION,
		label: githubIssueLabel(payload),
		payload,
		createdAt: new Date(),
	};
}

export interface ProposeForOwnerDeps {
	db: Db;
	pending: PendingActionsStore;
	notify: (userId: string, type: string, data: unknown) => void;
}

/**
 * A mission copilot's request becomes a pending action in the inbox of the
 * mission's owner — the human who can confirm it in the cockpit. Returns the
 * text the mission copilot receives.
 */
export async function proposeIssueForMissionOwner(
	deps: ProposeForOwnerDeps,
	missionId: string,
	raw: { title?: unknown; body?: unknown; labels?: unknown },
): Promise<{ pendingActionId: string; ownerUserId: string; message: string }> {
	const mission = await storedCollection(deps.db, "missions").findOne(
		{ missionId },
		{ projection: { userId: 1 } },
	);
	if (!mission) throw new Error(`Mission "${missionId}" not found`);
	const payload = parseGithubIssuePayload({
		op: "create",
		title: raw.title,
		body: raw.body,
		labels: raw.labels,
		missionId,
	});
	if (payload.op !== "create") throw new Error("unreachable: op is create");
	const action = githubIssuePendingAction(mission.userId, payload);
	await deps.pending.add(action);
	deps.notify(mission.userId, "copilot-action", {
		id: action.id,
		type: action.type,
		label: action.label,
		payload: action.payload,
	});
	return {
		pendingActionId: action.id,
		ownerUserId: mission.userId,
		message:
			`Proposed to the operator for confirmation (pending action ${action.id}): “${payload.title}”. ` +
			"Nothing has been filed yet — the issue is created only when the operator confirms the card in the cockpit.",
	};
}

/**
 * Open issues matching `q` (GitHub search syntax, repo- and state-scoped
 * here) or, with no `q`, the newest open issues. The plain issues-list
 * endpoint has no `q` parameter — passing one silently returned the same
 * first page every time (MCR3).
 */
export async function searchOpenIssues(
	opts: { q?: string; label?: string; perPage?: number },
	fetchFn: typeof ghFetch = ghFetch,
): Promise<
	Array<{
		number: number;
		title: string;
		labels: string[];
		body: string;
		html_url: string;
	}>
> {
	const perPage = Math.min(opts.perPage ?? 50, 100);
	type Item = {
		number: number;
		title: string;
		labels: Array<{ name: string }>;
		body: string | null;
		html_url: string;
	};
	let items: Item[];
	if (opts.q?.trim()) {
		const terms = [`repo:${GITHUB_REPO}`, "is:issue", "is:open"];
		if (opts.label) terms.push(`label:"${opts.label}"`);
		terms.push(opts.q.trim());
		const res = await fetchFn(
			`/search/issues?per_page=${perPage}&q=${encodeURIComponent(terms.join(" "))}`,
		);
		if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
		items = ((await res.json()) as { items: Item[] }).items;
	} else {
		const qs = opts.label ? `&labels=${encodeURIComponent(opts.label)}` : "";
		const res = await fetchFn(
			`/repos/${GITHUB_REPO}/issues?state=open&per_page=${perPage}${qs}`,
		);
		if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
		items = (await res.json()) as Item[];
	}
	return items.map((i) => ({
		number: i.number,
		title: i.title,
		labels: i.labels.map((l) => l.name),
		body: i.body ?? "",
		html_url: i.html_url,
	}));
}
