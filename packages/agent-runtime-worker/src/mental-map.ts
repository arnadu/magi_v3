import type { AgentConfig, TeamConfig } from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "./tools.js";

// ---------------------------------------------------------------------------
// Mental Map HTML template and initialiser
// ---------------------------------------------------------------------------

/**
 * Build the initial mental map HTML for a new agent.
 * The #mission-context section is populated from the team config.
 */
export function initMentalMap(agent: AgentConfig, team: TeamConfig): string {
	const teammates = team.agents
		.filter((a) => a.id !== agent.id)
		.map((a) => `${a.id} (${a.name}, ${a.role})`)
		.join(", ");

	const supervisorLabel =
		agent.supervisor === "user"
			? "user (operator)"
			: (() => {
					const sup = team.agents.find((a) => a.id === agent.supervisor);
					return sup ? `${sup.id} (${sup.name})` : agent.supervisor;
				})();

	return `<section id="mission-context">
  <p>Team: ${team.mission.name} | Role: ${agent.role} | Supervisor: ${supervisorLabel}</p>
  <p>Teammates: ${teammates || "none"}</p>
</section>
<section id="working-notes"><p></p></section>
<ul id="waiting-for"></ul>`;
}

// ---------------------------------------------------------------------------
// HTML patching — pure function, easily testable
// ---------------------------------------------------------------------------

/**
 * Apply a surgical patch to a mental map HTML string.
 *
 * - replace: set the inner content of element id="elementId" to `content`
 * - append:  append `content` to the inner content
 * - remove:  clear the inner content
 *
 * Returns the original HTML unchanged if the element is not found.
 */
export function patchMentalMap(
	html: string,
	operation: "replace" | "append" | "remove",
	elementId: string,
	content?: string,
): string {
	// Match <tagName ... id="elementId" ...>innerContent</tagName>
	// The tag name capture (group 2) is used as a back-reference in the closing tag.
	const pattern = new RegExp(
		`(<(\\w+)[^>]*\\sid="${elementId}"[^>]*>)([\\s\\S]*?)(<\\/\\2>)`,
	);
	const match = pattern.exec(html);
	if (!match) return html;

	const [fullMatch, openTag, , currentContent, closeTag] = match;
	const newContent =
		operation === "replace"
			? (content ?? "")
			: operation === "append"
				? currentContent + (content ?? "")
				: ""; // remove

	return html.replace(fullMatch, `${openTag}${newContent}${closeTag}`);
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface MentalMapRepository {
	/** Load the current mental map HTML for an agent. Returns null if not yet initialised. */
	load(agentId: string): Promise<string | null>;
	/** Persist the full mental map HTML. */
	save(agentId: string, html: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryMentalMapRepository implements MentalMapRepository {
	private readonly store = new Map<string, string>();

	async load(agentId: string): Promise<string | null> {
		return this.store.get(agentId) ?? null;
	}

	async save(agentId: string, html: string): Promise<void> {
		this.store.set(agentId, html);
	}
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

export async function createMongoMentalMapRepository(
	mongoUri: string,
	dbName = "magi",
): Promise<MentalMapRepository> {
	const { MongoClient } = await import("mongodb");
	const client = new MongoClient(mongoUri);
	await client.connect();
	const col = client
		.db(dbName)
		.collection<{ agentId: string; html: string; updatedAt: Date }>(
			"mental_maps",
		);

	return {
		async load(agentId) {
			const doc = await col.findOne({ agentId });
			return doc?.html ?? null;
		},
		async save(agentId, html) {
			await col.replaceOne(
				{ agentId },
				{ agentId, html, updatedAt: new Date() },
				{ upsert: true },
			);
		},
	};
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the UpdateMentalMap tool for an agent.
 * The tool loads, patches, and saves the mental map in one atomic step.
 */
export function createMentalMapTool(
	repo: MentalMapRepository,
	agentId: string,
): MagiTool {
	function ok(text: string): ToolResult {
		return { content: [{ type: "text", text }] };
	}
	function err(text: string): ToolResult {
		return { content: [{ type: "text", text }], isError: true };
	}

	return {
		name: "UpdateMentalMap",
		description:
			"Update a section of your mental map. " +
			"Available sections: #mission-context, #working-notes, #waiting-for. " +
			"Use 'replace' to overwrite a section, 'append' to add to it, 'remove' to clear it.",
		parameters: Type.Object({
			operation: Type.Union(
				[
					Type.Literal("replace"),
					Type.Literal("append"),
					Type.Literal("remove"),
				],
				{ description: "replace | append | remove" },
			),
			elementId: Type.String({
				description:
					"CSS id of the section to update (e.g. working-notes, waiting-for)",
			}),
			content: Type.Optional(
				Type.String({
					description:
						"HTML content to write (required for replace and append)",
				}),
			),
		}),
		async execute(_id, args) {
			const operation = args.operation as "replace" | "append" | "remove";
			const elementId = args.elementId as string;
			const content = args.content as string | undefined;

			if (operation !== "remove" && !content) {
				return err(
					"UpdateMentalMap: content is required for replace and append",
				);
			}

			const current = await repo.load(agentId);
			if (!current) {
				return err(
					"UpdateMentalMap: mental map not initialised for this agent",
				);
			}

			const updated = patchMentalMap(current, operation, elementId, content);
			if (updated === current && operation !== "remove") {
				return err(
					`UpdateMentalMap: element id="${elementId}" not found in mental map`,
				);
			}

			await repo.save(agentId, updated);
			return ok(`Mental map updated: ${operation} on #${elementId}`);
		},
	};
}
