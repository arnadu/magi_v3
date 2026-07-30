import type { AgentConfig } from "@magi/agent-config";
import { type MailboxMessage, safeTimestamp } from "./mailbox.js";
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
 * Rounding granularity for the current-time block. Agents have no need for
 * sub-5-minute precision, so rounding trades away nothing useful in exchange
 * for keeping buildDynamicContextMessage's output stable across calls a few
 * seconds apart within the same bucket.
 */
const TIME_ROUND_MS = 5 * 60 * 1000;

/**
 * Static pointer substituted for the {{mentalMap}} placeholder every team YAML
 * places at the end of agent.systemPrompt. The actual live mental map is NOT
 * here — see buildDynamicContextMessage. Keeping the system prompt free of
 * anything that changes within a session is what lets pi-ai's Anthropic
 * cache_control breakpoint (and OpenRouter's own default routing-key hash,
 * both of which fingerprint the system prompt as a single unit) survive a
 * mid-turn mental-map edit instead of invalidating on every single one — see
 * the OpenRouter caching investigation, issue #24.
 */
const MENTAL_MAP_POINTER =
	"(Your current mental map is provided as a separate message below — always up to date.)";

function isoMinute(d: Date): string {
	return `${d.toISOString().slice(0, 16)}Z`;
}

function formatLocal(d: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZoneName: "short",
	}).formatToParts(d);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

/**
 * Build the always-fresh current-time block injected into every system prompt.
 * Exported for direct unit testing without the filesystem dependencies of
 * buildSystemPrompt (discoverSkills reads sharedDir/workdir).
 */
export function buildTimeBlock(timezone?: string): string {
	const rounded = new Date(
		Math.floor(Date.now() / TIME_ROUND_MS) * TIME_ROUND_MS,
	);
	const weekday = new Intl.DateTimeFormat("en-US", {
		weekday: "long",
		timeZone: "UTC",
	}).format(rounded);
	const lines = [
		"## Current Time",
		"(Rounded to the nearest 5 minutes for prompt-cache efficiency — treat as approximate, not to-the-second.)",
		`- UTC: ${isoMinute(rounded)} (${weekday})`,
		`- Unix: ${Math.floor(rounded.getTime() / 1000)}`,
	];
	if (timezone) {
		lines.push(`- Local (${timezone}): ${formatLocal(rounded, timezone)}`);
	}
	return lines.join("\n");
}

/**
 * Build the system prompt for an agent's unified loop.
 *
 * Fully static per agent/session: reads agent.systemPrompt from the team YAML,
 * substitutes the {{mentalMap}} placeholder with a static pointer (the actual
 * live mental map is injected separately — see buildDynamicContextMessage),
 * and appends a rendering-capability note and a skills block listing all
 * discoverable skills across the platform, mission, and agent-private tiers.
 * Deliberately carries nothing that changes within a session (no mental map,
 * no timestamp) — see MENTAL_MAP_POINTER's doc comment.
 */
export function buildSystemPrompt(
	agent: AgentConfig,
	sharedDir: string,
	workdir: string,
): string {
	const base = agent.systemPrompt
		.replace(/\{\{mentalMap\}\}/g, MENTAL_MAP_POINTER)
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
 * The one part of the prompt that legitimately changes within a session: the
 * current-time block and the agent's live mental map. Kept OUT of the system
 * prompt (which pi-ai's Anthropic provider and OpenRouter's own default
 * routing hash both fingerprint as a single cache/routing unit) and injected
 * as its own message instead — replaced in place across inner-loop iterations
 * only when it actually changes (see loop.ts's runInnerLoop), so the system
 * prompt stays byte-identical call to call even across a mid-turn mental-map
 * edit. See the OpenRouter caching investigation, issue #24.
 */
export function buildDynamicContextMessage(
	mentalMapHtml: string,
	timezone?: string,
): string {
	return `${buildTimeBlock(timezone)}\n\n## Your Mental Map\n${mentalMapHtml}`;
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
			// Always shown, even for a single recipient (matches ReadMessage's
			// convention) — without it, a multi-recipient message gives no
			// agent any way to know who else received the same message, so
			// two agents CC'd on one message reply as if in separate private
			// threads instead of a shared one. Found live: an operator
			// message to both the mission copilot and an agent got two
			// uncoordinated replies.
			`To: ${m.to.join(", ")}`,
			`Subject: ${m.subject}`,
			`Time: ${safeTimestamp(m)}`,
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
