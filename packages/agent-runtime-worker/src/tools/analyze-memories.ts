import { Type } from "@sinclair/typebox";
import type { ConversationRepository } from "../conversation-repository.js";
import type { MagiTool } from "../tools.js";

export interface AnalyzeMemoriesConfig {
	conversationRepo: ConversationRepository;
	agentId: string;
	missionId: string;
}

/**
 * Parent-process tool (no subprocess isolation) that searches the full
 * conversation history — including compacted and pruned messages — for
 * content matching a keyword query.
 *
 * Agents use this to recover tool outputs that were stubbed out by the
 * mid-session or cross-session ephemeral pruning.
 */
export function createAnalyzeMemoriesTool(
	cfg: AnalyzeMemoriesConfig,
): MagiTool {
	return {
		name: "AnalyzeMemories",
		description:
			"Search your full conversation history (including pruned or compacted turns) " +
			"for tool outputs and messages that match a keyword query. " +
			"Use this to recover content that was removed from context to save space.",
		parameters: Type.Object({
			query: Type.String({
				description: "Keywords to search for (case-insensitive).",
			}),
			limit: Type.Optional(
				Type.Number({
					description:
						"Maximum number of results to return (default: 5, max: 20).",
				}),
			),
		}),
		async execute(_id, args) {
			const { query, limit = 5 } = args as { query: string; limit?: number };
			const q = String(query).trim();
			if (!q) {
				return {
					content: [{ type: "text", text: "query must not be empty" }],
					isError: true,
				};
			}
			const results = await cfg.conversationRepo.findRelevant(
				cfg.agentId,
				cfg.missionId,
				q,
				Math.min(Number(limit) || 5, 20),
			);
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No memories found for: "${q}"` }],
				};
			}
			const lines = results.map((r) => {
				const who = r.toolName ? `${r.role}/${r.toolName}` : r.role;
				const when = r.savedAt.toISOString().slice(0, 16);
				return `[turn ${r.turnNumber} | ${who} | ${when}]\n${r.excerpt}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n\n---\n\n") }],
			};
		},
	};
}
