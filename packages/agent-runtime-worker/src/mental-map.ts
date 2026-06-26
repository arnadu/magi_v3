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
// HTML editing — pure functions, easily testable
// ---------------------------------------------------------------------------
//
// Protection model (V2-derived): **id-addressability is the permission
// boundary.** The agent's tools can only act on elements that carry an `id`.
// Elements without an `id` are unreachable and therefore permanent — this is
// how a template embeds high-level structure and standing instructions the
// agent cannot erase. Daemon-managed regions (e.g. the objectives sync) carry
// no `id` and are addressed by a `data-managed` attribute instead, so the
// agent's id-only tools cannot touch them either. To keep that boundary intact
// the sanitiser strips `id` and `data-managed` from agent-supplied content, so
// an agent cannot smuggle in a new id'd element or spoof a managed region — the
// only id it can introduce is the validated `new_id` of `mental_map_add`.

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Sanitise an agent-supplied HTML fragment: drop scripts and `on*` handlers
 * (XSS defence in depth for the UI), and strip `id` + `data-managed` attributes
 * so agent content cannot create addressable ids or spoof managed regions.
 */
function sanitizeFragment(fragment: string, doc: Document): string {
	const div = doc.createElement("div");
	div.innerHTML = fragment;
	for (const el of Array.from(div.querySelectorAll("script"))) el.remove();
	for (const el of Array.from(div.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || name === "id" || name === "data-managed") {
				el.removeAttribute(attr.name);
			}
		}
	}
	return div.innerHTML;
}

export type EditResult =
	| { ok: true; html: string }
	| { ok: false; error: string };

/** Update the *content* of an existing id'd element (replace or append). */
export function updateElement(
	html: string,
	targetId: string,
	content: string,
	mode: "replace" | "append",
): EditResult {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const el = doc.getElementById(targetId);
	if (!el)
		return { ok: false, error: `no element with id="${targetId}" exists` };
	const clean = sanitizeFragment(content, doc);
	el.innerHTML = mode === "append" ? el.innerHTML + clean : clean;
	return { ok: true, html: doc.body.innerHTML };
}

/** Create a new id'd `<div>` as the last child of an existing parent element. */
export function addElement(
	html: string,
	newId: string,
	parentId: string,
	content: string,
): EditResult {
	if (!ID_PATTERN.test(newId))
		return {
			ok: false,
			error: `invalid new_id "${newId}" — use a slug like "finding-3" (lowercase letters, digits, hyphens; must start with a letter)`,
		};
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	if (doc.getElementById(newId))
		return {
			ok: false,
			error: `id "${newId}" already exists — choose another`,
		};
	const parent = doc.getElementById(parentId);
	if (!parent)
		return {
			ok: false,
			error: `no parent element with id="${parentId}" exists`,
		};
	const el = doc.createElement("div");
	el.id = newId;
	el.innerHTML = sanitizeFragment(content, doc);
	parent.appendChild(el);
	return { ok: true, html: doc.body.innerHTML };
}

/** Delete an id'd element entirely. */
export function removeElement(html: string, targetId: string): EditResult {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const el = doc.getElementById(targetId);
	if (!el)
		return { ok: false, error: `no element with id="${targetId}" exists` };
	el.remove();
	return { ok: true, html: doc.body.innerHTML };
}

/**
 * Insert-or-replace a daemon-managed region, addressed by a `data-managed`
 * attribute (never an `id`). The region is created at the top of the body if
 * absent, so it can be synced into any agent's mental map without the template
 * declaring it. Because it has no `id`, the agent's id-only tools cannot reach
 * it — it is protected by the same rule as non-id'd structure.
 */
export function upsertManagedRegion(
	html: string,
	managedKey: string,
	innerHtml: string,
): string {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	let el = doc.querySelector(`[data-managed="${managedKey}"]`);
	if (!el) {
		el = doc.createElement("section");
		el.setAttribute("data-managed", managedKey);
		doc.body.insertBefore(el, doc.body.firstChild);
	}
	// Managed content is daemon-authored; still sanitise scripts/handlers.
	el.innerHTML = sanitizeFragment(innerHtml, doc);
	return doc.body.innerHTML;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the three mental-map editing tools for an agent:
 *   - mental_map_update — edit the content of an existing id'd element
 *   - mental_map_add    — create a new id'd element inside a parent
 *   - mental_map_remove — delete an id'd element
 *
 * Every operation is addressed by `id`, so non-id'd structure and `data-managed`
 * regions are immutable by construction. The tools operate purely in-memory via
 * get/set callbacks; the map is persisted as a snapshot on each AssistantMessage.
 */
export function createMentalMapTools(
	getHtml: () => string | null,
	setHtml: (html: string) => void,
): MagiTool[] {
	const ok = (text: string): ToolResult => ({
		content: [{ type: "text", text }],
	});
	const err = (text: string): ToolResult => ({
		content: [{ type: "text", text }],
		isError: true,
	});

	const apply = (
		result: EditResult,
		success: string,
		toolName: string,
	): ToolResult => {
		if (!result.ok) return err(`${toolName}: ${result.error}`);
		setHtml(result.html);
		return ok(success);
	};

	const requireMap = (): string | null => getHtml();

	const update: MagiTool = {
		name: "mental_map_update",
		description:
			"Update the content of an EXISTING element in your mental map, addressed " +
			"by its id. mode='replace' overwrites the element's content; mode='append' " +
			"adds to it. Only elements that have an id can be updated. " +
			'Example: mental_map_update({ target_id: "working-notes", mode: "append", content: "<p>Found the 10-Q.</p>" }).',
		parameters: Type.Object({
			target_id: Type.String({
				description: "id of the existing element to edit",
			}),
			mode: Type.Union([Type.Literal("replace"), Type.Literal("append")], {
				description: "replace = overwrite content; append = add to it",
			}),
			content: Type.String({ description: "HTML content to write" }),
		}),
		execute(_id, args) {
			const html = requireMap();
			if (!html)
				return Promise.resolve(err("mental_map_update: not initialised"));
			return Promise.resolve(
				apply(
					updateElement(
						html,
						args.target_id as string,
						args.content as string,
						args.mode as "replace" | "append",
					),
					`Updated #${args.target_id}`,
					"mental_map_update",
				),
			);
		},
	};

	const add: MagiTool = {
		name: "mental_map_add",
		description:
			"Add a NEW id'd element to your mental map as the last child of an existing " +
			"parent element. Use this to grow your notes within the map's structure. " +
			'Example: mental_map_add({ new_id: "finding-3", parent_id: "working-notes", content: "<p>NVDA margins up.</p>" }).',
		parameters: Type.Object({
			new_id: Type.String({
				description:
					"id for the new element (slug: lowercase letters, digits, hyphens). Use it later to update or remove the element.",
			}),
			parent_id: Type.String({
				description: "id of the existing element to add the new element inside",
			}),
			content: Type.String({ description: "HTML content of the new element" }),
		}),
		execute(_id, args) {
			const html = requireMap();
			if (!html) return Promise.resolve(err("mental_map_add: not initialised"));
			return Promise.resolve(
				apply(
					addElement(
						html,
						args.new_id as string,
						args.parent_id as string,
						args.content as string,
					),
					`Added #${args.new_id} inside #${args.parent_id}`,
					"mental_map_add",
				),
			);
		},
	};

	const remove: MagiTool = {
		name: "mental_map_remove",
		description:
			"Delete an element from your mental map, addressed by its id. Removes the " +
			"whole element (not just its content). Only id'd elements can be removed. " +
			'Example: mental_map_remove({ target_id: "finding-3" }).',
		parameters: Type.Object({
			target_id: Type.String({ description: "id of the element to delete" }),
		}),
		execute(_id, args) {
			const html = requireMap();
			if (!html)
				return Promise.resolve(err("mental_map_remove: not initialised"));
			return Promise.resolve(
				apply(
					removeElement(html, args.target_id as string),
					`Removed #${args.target_id}`,
					"mental_map_remove",
				),
			);
		},
	};

	return [update, add, remove];
}
