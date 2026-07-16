import { randomUUID } from "node:crypto";
import type { TeamConfig } from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import type { Db } from "mongodb";
import type { MagiTool, ToolResult } from "./tools.js";

/** Maximum message body length. Shared with monitor-server to keep the cap consistent. */
export const MAILBOX_MAX_BODY_BYTES = 100_000;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface MailboxMessage {
	id: string;
	missionId: string;
	from: string; // agent id or "user"
	to: string[]; // agent ids and/or "user"
	subject: string;
	body: string;
	timestamp: Date;
	readBy: string[]; // agent ids that have called ReadMessage on this
}

/**
 * ISO string for a message's timestamp, or "unknown" if it's missing/invalid.
 * `timestamp` is typed as a required Date, but at least one write path
 * (control-plane's scheduler.ts) has inserted mailbox documents directly,
 * bypassing MailboxRepository.post(), without it — this must never throw,
 * since prompt.ts calls it while building the receiving agent's entire turn.
 */
export function safeTimestamp(m: MailboxMessage): string {
	return m.timestamp instanceof Date && !Number.isNaN(m.timestamp.valueOf())
		? m.timestamp.toISOString()
		: "unknown";
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface MailboxRepository {
	/** Persist a new message. Assigns id and timestamp. */
	post(
		msg: Omit<MailboxMessage, "id" | "timestamp" | "readBy">,
	): Promise<MailboxMessage>;

	/** Return all messages addressed to agentId that have not been read by agentId. */
	listUnread(agentId: string): Promise<MailboxMessage[]>;

	/** Mark messages as read by agentId. */
	markRead(messageIds: string[], agentId: string): Promise<void>;

	/** True if agentId has any unread messages. */
	hasUnread(agentId: string): Promise<boolean>;

	/** List all messages addressed to agentId (for ListMessages tool). */
	list(
		agentId: string,
		opts?: { limit?: number; since?: Date; search?: string },
	): Promise<MailboxMessage[]>;

	/** Fetch a single message by id (for ReadMessage tool). */
	get(messageId: string): Promise<MailboxMessage | null>;
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

/**
 * Create a mailbox repository scoped to a single mission.
 * All reads and writes are automatically filtered by missionId, preventing
 * cross-mission message leakage (critical when multiple missions share a db).
 */
export function createMongoMailboxRepository(
	db: Db,
	missionId: string,
): MailboxRepository {
	const col = db.collection<MailboxMessage & { _id?: unknown }>("mailbox");

	return {
		async post(msg) {
			const full: MailboxMessage = {
				...msg,
				id: randomUUID(),
				timestamp: new Date(),
				readBy: [],
			};
			await col.insertOne({ ...full });
			return full;
		},

		async listUnread(agentId) {
			return col
				.find({ missionId, to: agentId, readBy: { $ne: agentId } })
				.sort({ timestamp: 1 })
				.toArray();
		},

		async markRead(messageIds, agentId) {
			await col.updateMany(
				{ missionId, id: { $in: messageIds } },
				{ $addToSet: { readBy: agentId } },
			);
		},

		async hasUnread(agentId) {
			return (
				(await col.countDocuments({
					missionId,
					to: agentId,
					readBy: { $ne: agentId },
				})) > 0
			);
		},

		async list(agentId, opts = {}) {
			const filter: Record<string, unknown> = { missionId, to: agentId };
			if (opts.since) filter.timestamp = { $gte: opts.since };
			if (opts.search) {
				// Escape regex metacharacters and cap length to prevent ReDoS (F-004).
				const escaped = opts.search
					.slice(0, 200)
					.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				filter.$or = [
					{ subject: { $regex: escaped, $options: "i" } },
					{ body: { $regex: escaped, $options: "i" } },
				];
			}
			return col
				.find(filter)
				.sort({ timestamp: -1 })
				.limit(opts.limit ?? 50)
				.toArray();
		},

		async get(messageId) {
			return col.findOne({ missionId, id: messageId });
		},
	};
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface MailboxToolOptions {
	/** Called immediately when a message is posted with "user" in the to list. */
	onUserMessage?: (msg: MailboxMessage) => void;
	/** Called after every successful PostMessage execution. */
	onPost?: (msg: MailboxMessage) => void;
}

/**
 * Create the four mailbox tools for an agent.
 * All tool calls are scoped to `fromAgentId` as the sender.
 */
export function createMailboxTools(
	repo: MailboxRepository,
	teamConfig: TeamConfig,
	fromAgentId: string,
	opts: MailboxToolOptions = {},
): MagiTool[] {
	function ok(text: string): ToolResult {
		return { content: [{ type: "text", text }] };
	}
	function err(text: string): ToolResult {
		return { content: [{ type: "text", text }], isError: true };
	}

	/** Valid recipient IDs: every agent in the team plus "user" for the operator. */
	const validRecipients = new Set([
		...teamConfig.agents.map((a) => a.id),
		"user",
	]);
	const MAX_BODY_BYTES = MAILBOX_MAX_BODY_BYTES;

	// ── PostMessage ────────────────────────────────────────────────────────────

	const postMessage: MagiTool = {
		name: "PostMessage",
		description:
			"Send a message to one or more agents or to the operator. " +
			'Use "user" as a recipient id to send a message to the operator. ' +
			"Messages are delivered to the recipient's inbox immediately.",
		parameters: Type.Object({
			to: Type.Array(Type.String(), {
				description: 'Recipient agent ids (or "user" for the operator)',
			}),
			subject: Type.String({ description: "Message subject line" }),
			body: Type.String({ description: "Message body" }),
		}),
		async execute(_id, args) {
			// The schema declares to: string[] for LLM-driven tool calls (always
			// schema-conformant), but this tool is also reachable via the raw HTTP
			// tool-api-server path (background job scripts), which sends whatever
			// JSON shape the caller built — no schema validation applied. A single
			// recipient string is common there (e.g. magi_tool.py's post_message(to:
			// str, ...)); coerce it rather than let `.filter` below throw a raw
			// TypeError that surfaces as an unhandled 500.
			const rawTo = args.to;
			const to = Array.isArray(rawTo)
				? (rawTo as string[])
				: typeof rawTo === "string"
					? [rawTo]
					: null;
			const subject = args.subject as string;
			const body = args.body as string;

			if (to === null) {
				return err('PostMessage: "to" must be a string or an array of strings');
			}
			if (to.length === 0) return err("PostMessage: to[] must not be empty");

			const unknown = to.filter((id) => !validRecipients.has(id));
			if (unknown.length > 0) {
				return err(`PostMessage: unknown recipients: ${unknown.join(", ")}`);
			}

			if (body.length > MAX_BODY_BYTES) {
				return err(
					`PostMessage: body too large (${body.length} chars, max ${MAX_BODY_BYTES})`,
				);
			}

			const msg = await repo.post({
				missionId: teamConfig.mission.id,
				from: fromAgentId,
				to,
				subject,
				body,
			});

			// Print user-bound messages immediately to stdout
			if (to.includes("user")) {
				opts.onUserMessage?.(msg);
			}

			opts.onPost?.(msg);

			return ok(`Message sent (id: ${msg.id}) to: ${to.join(", ")}`);
		},
	};

	// ── ListTeam ───────────────────────────────────────────────────────────────

	const listTeam: MagiTool = {
		name: "ListTeam",
		description:
			"List all agents in the team with their id, name, role, and supervisor.",
		parameters: Type.Object({}),
		async execute() {
			const lines = teamConfig.agents.map(
				(a) =>
					`id=${a.id}  name=${a.name}  role=${a.role}  supervisor=${a.supervisor}`,
			);
			return ok(lines.join("\n"));
		},
	};

	// ── ListMessages ───────────────────────────────────────────────────────────

	const listMessages: MagiTool = {
		name: "ListMessages",
		description:
			"List message headers in your inbox. Use for reviewing older messages; " +
			"new messages for this run are already shown in the conversation.",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({ description: "Max messages to return (default: 20)" }),
			),
			since: Type.Optional(
				Type.String({
					description: "ISO 8601 timestamp — only return messages after this",
				}),
			),
			search: Type.Optional(
				Type.String({ description: "Filter by keyword in subject or body" }),
			),
		}),
		async execute(_id, args) {
			const messages = await repo.list(fromAgentId, {
				limit: (args.limit as number | undefined) ?? 20,
				since: args.since ? new Date(args.since as string) : undefined,
				search: args.search as string | undefined,
			});
			if (messages.length === 0) return ok("No messages.");
			const lines = messages.map(
				(m) =>
					`id=${m.id}  from=${m.from}  subject="${m.subject}"  time=${safeTimestamp(m)}`,
			);
			return ok(lines.join("\n"));
		},
	};

	// ── ReadMessage ────────────────────────────────────────────────────────────

	const readMessage: MagiTool = {
		name: "ReadMessage",
		description: "Read the full body of a message by id.",
		parameters: Type.Object({
			id: Type.String({ description: "Message id from ListMessages" }),
		}),
		async execute(_callId, args) {
			const msg = await repo.get(args.id as string);
			if (!msg) return err(`Message ${args.id} not found`);
			await repo.markRead([msg.id], fromAgentId);
			return ok(
				`From: ${msg.from}\nTo: ${msg.to.join(", ")}\nSubject: ${msg.subject}\nTime: ${safeTimestamp(msg)}\n\n${msg.body}`,
			);
		},
	};

	return [postMessage, listTeam, listMessages, readMessage];
}
