import type { AgentConfig } from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import { JSDOM } from "jsdom";
import type { MagiTool, ToolResult } from "./tools.js";

// ---------------------------------------------------------------------------
// Mental Map HTML template and initialiser
// ---------------------------------------------------------------------------

/**
 * Return the initial mental map HTML for a new agent.
 * Reads agent.initialMentalMap from the team YAML.
 */
export function initMentalMap(agent: AgentConfig): string {
	return agent.initialMentalMap;
}

// ---------------------------------------------------------------------------
// HTML patching — pure function, easily testable
// ---------------------------------------------------------------------------

/**
 * Strip script elements and on* event handler attributes from an HTML fragment.
 * Agents write structural HTML (<p>, <li>, etc.) to the mental map, so we
 * preserve innerHTML but remove XSS vectors before they reach MongoDB — this
 * is defence-in-depth for when the UI frontend is added in Sprint 10.
 */
function sanitizeHtml(fragment: string, doc: Document): string {
	const div = doc.createElement("div");
	div.innerHTML = fragment;
	for (const el of Array.from(div.querySelectorAll("script"))) {
		el.remove();
	}
	for (const el of Array.from(div.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			if (attr.name.toLowerCase().startsWith("on")) {
				el.removeAttribute(attr.name);
			}
		}
	}
	return div.innerHTML;
}

/**
 * Apply a surgical patch to a mental map HTML fragment.
 *
 * - replace: set the inner content of element id="elementId" to `content`
 * - append:  append `content` to the inner content
 * - remove:  clear the inner content
 *
 * Returns `null` if no element with the given id is found (the caller can
 * then surface a clear error to the agent instead of silently doing nothing).
 * Uses jsdom for robust HTML manipulation rather than fragile regex.
 */
export function patchMentalMap(
	html: string,
	operation: "replace" | "append" | "remove",
	elementId: string,
	content?: string,
): string | null {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const el = doc.getElementById(elementId);
	if (!el) return null;

	switch (operation) {
		case "replace":
			el.innerHTML = sanitizeHtml(content ?? "", doc);
			break;
		case "append":
			el.innerHTML += sanitizeHtml(content ?? "", doc);
			break;
		case "remove":
			el.innerHTML = "";
			break;
	}

	return doc.body.innerHTML;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the UpdateMentalMap tool for an agent.
 *
 * The tool operates purely in-memory via get/set callbacks — no database
 * writes on each call. The mental map is persisted as a snapshot on each
 * AssistantMessage stored in conversationMessages.
 *
 * @param getHtml - Returns the current mental map HTML (or null if not yet set).
 * @param setHtml - Called with the updated HTML after a successful patch.
 */
export function createMentalMapTool(
	getHtml: () => string | null,
	setHtml: (html: string) => void,
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
		execute(_id, args) {
			const operation = args.operation as "replace" | "append" | "remove";
			const elementId = args.elementId as string;
			const content = args.content as string | undefined;

			if (operation !== "remove" && !content) {
				return Promise.resolve(
					err("UpdateMentalMap: content is required for replace and append"),
				);
			}

			const current = getHtml();
			if (!current) {
				return Promise.resolve(
					err("UpdateMentalMap: mental map not initialised for this agent"),
				);
			}

			const updated = patchMentalMap(current, operation, elementId, content);
			if (updated === null) {
				return Promise.resolve(
					err(`UpdateMentalMap: element id="${elementId}" not found in mental map`),
				);
			}

			setHtml(updated);
			return Promise.resolve(
				ok(`Mental map updated: ${operation} on #${elementId}`),
			);
		},
	};
}
