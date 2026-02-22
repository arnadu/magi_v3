import type { AgentConfig, TeamConfig } from "@magi/agent-config";
import type { MailboxMessage } from "./mailbox.js";

/**
 * Build the system prompt for an agent's unified loop.
 *
 * Static parts (identity, team, instructions) are assembled from the team config.
 * The mental map HTML is fetched fresh before each run and injected here.
 */
export function buildSystemPrompt(
	agent: AgentConfig,
	team: TeamConfig,
	mentalMapHtml: string,
): string {
	const teammates = team.agents
		.filter((a) => a.id !== agent.id)
		.map(
			(a) => `- ${a.id} (${a.name}, ${a.role}): supervisor is ${a.supervisor}`,
		)
		.join("\n");

	const supervisorDesc =
		agent.supervisor === "user"
			? "The operator (user). Report results and escalations directly to them via PostMessage."
			: (() => {
					const sup = team.agents.find((a) => a.id === agent.supervisor);
					const label = sup ? `${sup.name} (${sup.id})` : agent.supervisor;
					return `${label}. Report results and escalations to them via PostMessage.`;
				})();

	return `You are ${agent.name}, the ${agent.role} of the ${team.mission.name}.

## Mission
${agent.mission.trim()}

## Your team
${teammates || "You are the only agent on this team."}

## Your supervisor
${supervisorDesc}

## Your mental map
${mentalMapHtml}

## How to work
Your new messages are shown in the conversation below. Process them and act:
- Use PostMessage to reply to teammates or report to your supervisor
- Use Bash, WriteFile, or EditFile for file or shell work
- Use UpdateMentalMap to record progress, waiting items, and notes
- When you have finished all actions for this cycle, stop calling tools

Do the work now — do not defer execution tasks. If you are blocked or cannot
complete a task, escalate via PostMessage to your supervisor.`.trim();
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
