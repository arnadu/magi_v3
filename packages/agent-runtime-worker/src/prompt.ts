import type { AgentConfig } from "@magi/agent-config";
import type { MailboxMessage } from "./mailbox.js";

/**
 * Build the system prompt for an agent's unified loop.
 *
 * Reads agent.systemPrompt from the team YAML and substitutes the
 * {{mentalMap}} placeholder with the agent's current mental map HTML.
 */
export function buildSystemPrompt(
	agent: AgentConfig,
	mentalMapHtml: string,
): string {
	return agent.systemPrompt.replace("{{mentalMap}}", mentalMapHtml);
}

/**
 * Format a list of mailbox messages as the opening user turn.
 * The orchestrator passes pre-fetched unread messages this way,
 * avoiding a ListMessages round-trip at the start of the agent's LLM call.
 */
export function formatMessages(messages: MailboxMessage[]): string {
	if (messages.length === 0) {
		return "You have no new messages. Review your mental map and decide what to do next.";
	}

	const parts = messages.map((m, i) => {
		const header = [
			`--- Message ${i + 1} ---`,
			`From: ${m.from}`,
			`Subject: ${m.subject}`,
			`Time: ${m.timestamp.toISOString()}`,
			"",
			m.body,
			"-".repeat(18),
		].join("\n");
		return header;
	});

	const count = messages.length;
	const noun = count === 1 ? "message" : "messages";
	return `You have ${count} new ${noun}:\n\n${parts.join("\n\n")}`;
}
