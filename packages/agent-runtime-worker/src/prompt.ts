import type { AgentConfig } from "@magi/agent-config";
import type { MailboxMessage } from "./mailbox.js";
import { discoverSkills, formatSkillsBlock } from "./skills.js";

/**
 * Always-injected, so every agent knows it regardless of team-specific
 * systemPrompt content — the operator's cockpit renders this; an agent that
 * doesn't know it will just write plain, unstructured text forever.
 */
const RENDERING_NOTE = [
	"## Rich Text Rendering",
	"Mailbox messages (PostMessage) and .md files you write to the shared workspace" +
		" are rendered as formatted text in the operator's cockpit — not shown as raw" +
		" markup. This does NOT apply to your mental map, which is raw HTML.",
	"",
	"Supported:",
	"- Markdown: # headings, **bold**, *italic*, [links](https://...), bullet lists," +
		" `inline code`, fenced code blocks, and GFM tables" +
		" (`| a | b |` / `|---|---|` / `| 1 | 2 |`)",
	"- Mermaid diagrams: a fenced code block tagged `mermaid`" +
		" (e.g. ```mermaid / graph TD; A-->B; / ```)",
	"- KaTeX math, BLOCK ONLY, wrapped in $$...$$ (e.g. $$x^2 + y^2 = z^2$$)." +
		" Do NOT use single-$ inline math — dollar amounts in normal text" +
		' (e.g. "$5.00 per share") would be misread as math.',
].join("\n");

/**
 * Build the system prompt for an agent's unified loop.
 *
 * Reads agent.systemPrompt from the team YAML, substitutes the
 * {{mentalMap}} placeholder with the agent's current mental map HTML,
 * and appends a rendering-capability note plus a skills block listing all
 * discoverable skills across the platform, mission, and agent-private tiers.
 */
export function buildSystemPrompt(
	agent: AgentConfig,
	mentalMapHtml: string,
	sharedDir: string,
	workdir: string,
): string {
	const base = agent.systemPrompt
		.replace(/\{\{mentalMap\}\}/g, mentalMapHtml)
		.replace(/\{\{sharedDir\}\}/g, sharedDir)
		.replace(/\{\{workdir\}\}/g, workdir);
	const block = discoverSkills(sharedDir, workdir);
	const disabled = new Set(agent.disabledSkills ?? []);
	const filtered = {
		...block,
		skills: block.skills.filter((s) => !disabled.has(s.name)),
	};
	const skillsBlock = formatSkillsBlock(filtered);
	return `${base}\n\n${RENDERING_NOTE}\n\n${skillsBlock}`;
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
