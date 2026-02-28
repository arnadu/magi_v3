import { randomUUID } from "node:crypto";
import type { TeamConfig } from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "./tools.js";

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
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryMailboxRepository implements MailboxRepository {
	private readonly messages: MailboxMessage[] = [];

	async post(
		msg: Omit<MailboxMessage, "id" | "timestamp" | "readBy">,
	): Promise<MailboxMessage> {
		const full: MailboxMessage = {
			...msg,
			id: randomUUID(),
			timestamp: new Date(),
			readBy: [],
		};
		this.messages.push(full);
		return full;
	}

	async listUnread(agentId: string): Promise<MailboxMessage[]> {
		return this.messages.filter(
			(m) => m.to.includes(agentId) && !m.readBy.includes(agentId),
		);
	}

	async markRead(messageIds: string[], agentId: string): Promise<void> {
		for (const msg of this.messages) {
			if (messageIds.includes(msg.id) && !msg.readBy.includes(agentId)) {
				msg.readBy.push(agentId);
			}
		}
	}

	async hasUnread(agentId: string): Promise<boolean> {
		return this.messages.some(
			(m) => m.to.includes(agentId) && !m.readBy.includes(agentId),
		);
	}

	async list(
		agentId: string,
		opts: { limit?: number; since?: Date; search?: string } = {},
	): Promise<MailboxMessage[]> {
		let results = this.messages.filter((m) => m.to.includes(agentId));
		if (opts.since) {
			results = results.filter((m) => m.timestamp >= (opts.since as Date));
		}
		if (opts.search) {
			const q = opts.search.toLowerCase();
			results = results.filter(
				(m) =>
					m.subject.toLowerCase().includes(q) ||
					m.body.toLowerCase().includes(q),
			);
		}
		// Sort newest-first to match the MongoDB implementation.
		results = [...results].sort(
			(a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
		);
		return results.slice(0, opts.limit ?? 50);
	}

	async get(messageId: string): Promise<MailboxMessage | null> {
		return this.messages.find((m) => m.id === messageId) ?? null;
	}
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

export async function createMongoMailboxRepository(
	mongoUri: string,
	dbName = "magi",
): Promise<MailboxRepository> {
	const { MongoClient } = await import("mongodb");
	const client = new MongoClient(mongoUri);
	await client.connect();
	const col = client
		.db(dbName)
		.collection<MailboxMessage & { _id?: unknown }>("mailbox");

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
				.find({ to: agentId, readBy: { $ne: agentId } })
				.sort({ timestamp: 1 })
				.toArray();
		},

		async markRead(messageIds, agentId) {
			await col.updateMany(
				{ id: { $in: messageIds } },
				{ $addToSet: { readBy: agentId } },
			);
		},

		async hasUnread(agentId) {
			return (
				(await col.countDocuments({ to: agentId, readBy: { $ne: agentId } })) >
				0
			);
		},

		async list(agentId, opts = {}) {
			const filter: Record<string, unknown> = { to: agentId };
			if (opts.since) filter.timestamp = { $gte: opts.since };
			if (opts.search) {
				filter.$or = [
					{ subject: { $regex: opts.search, $options: "i" } },
					{ body: { $regex: opts.search, $options: "i" } },
				];
			}
			return col
				.find(filter)
				.sort({ timestamp: -1 })
				.limit(opts.limit ?? 50)
				.toArray();
		},

		async get(messageId) {
			return col.findOne({ id: messageId });
		},
	};
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface MailboxToolOptions {
	/** Called immediately when a message is posted with "user" in the to list. */
	onUserMessage?: (msg: MailboxMessage) => void;
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
	/** Maximum message body length to prevent mailbox memory exhaustion. */
	const MAX_BODY_BYTES = 100_000;

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
			const to = args.to as string[];
			const subject = args.subject as string;
			const body = args.body as string;

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
					`id=${m.id}  from=${m.from}  subject="${m.subject}"  time=${m.timestamp.toISOString()}`,
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
				`From: ${msg.from}\nTo: ${msg.to.join(", ")}\nSubject: ${msg.subject}\nTime: ${msg.timestamp.toISOString()}\n\n${msg.body}`,
			);
		},
	};

	return [postMessage, listTeam, listMessages, readMessage];
}
