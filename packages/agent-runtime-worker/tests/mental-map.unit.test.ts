/**
 * Mental-map editing model — unit tests (Sprint 26a, B1 revision).
 *
 * Protection model: id-addressability is the permission boundary. The agent's
 * tools act only on id'd elements; non-id'd elements (structure, instructions)
 * and data-managed regions are unreachable.
 */

import { describe, expect, it } from "vitest";
import {
	addElement,
	createMentalMapTools,
	removeElement,
	updateElement,
} from "../src/mental-map.js";

describe("updateElement", () => {
	const html = '<section id="notes"><p>old</p></section>';

	it("replaces content of an id'd element", () => {
		const r = updateElement(html, "notes", "<p>new</p>", "replace");
		expect(r.ok && r.html).toContain("new");
		expect(r.ok && r.html).not.toContain("old");
	});

	it("appends content", () => {
		const r = updateElement(html, "notes", "<p>more</p>", "append");
		expect(r.ok && r.html).toContain("old");
		expect(r.ok && r.html).toContain("more");
	});

	it("fails on a non-existent id", () => {
		const r = updateElement(html, "nope", "x", "replace");
		expect(r.ok).toBe(false);
	});

	it("cannot reach a non-id'd element (it is permanent)", () => {
		// A standing instruction with no id is unaddressable.
		const withInstruction = `<p>ALWAYS check your inbox.</p>${html}`;
		// There is no id to target it; updating "notes" never touches it.
		const r = updateElement(withInstruction, "notes", "<p>x</p>", "replace");
		expect(r.ok && r.html).toContain("ALWAYS check your inbox.");
	});
});

describe("addElement", () => {
	const html = '<section id="working-notes"></section>';

	it("adds a new id'd element inside a parent", () => {
		const r = addElement(html, "finding-1", "working-notes", "<p>hi</p>");
		expect(r.ok).toBe(true);
		expect(r.ok && r.html).toContain('id="finding-1"');
		expect(r.ok && r.html).toContain("hi");
	});

	it("rejects an invalid new_id", () => {
		const r = addElement(html, "Bad ID!", "working-notes", "x");
		expect(r.ok).toBe(false);
	});

	it("rejects a duplicate id", () => {
		const r = addElement(
			'<section id="working-notes"><div id="dup"></div></section>',
			"dup",
			"working-notes",
			"x",
		);
		expect(r.ok).toBe(false);
	});

	it("rejects a missing parent", () => {
		const r = addElement(html, "ok-id", "ghost", "x");
		expect(r.ok).toBe(false);
	});

	it("strips id/data-managed/script from injected content (anti-spoof)", () => {
		const r = addElement(
			html,
			"wrap",
			"working-notes",
			'<div id="sneaky" data-managed="my-objectives">x</div><script>bad()</script>',
		);
		expect(r.ok).toBe(true);
		const out = r.ok ? r.html : "";
		expect(out).toContain('id="wrap"'); // only the validated wrapper id survives
		expect(out).not.toContain('id="sneaky"');
		expect(out).not.toContain("data-managed");
		expect(out).not.toContain("<script>");
		expect(out).toContain("x");
	});
});

describe("removeElement", () => {
	it("deletes an id'd element entirely", () => {
		const r = removeElement(
			'<section id="a"><div id="b">x</div></section>',
			"b",
		);
		expect(r.ok && r.html).not.toContain('id="b"');
		expect(r.ok && r.html).toContain('id="a"');
	});

	it("fails on a non-existent id", () => {
		expect(removeElement("<p>x</p>", "nope").ok).toBe(false);
	});
});

describe("createMentalMapTools", () => {
	it("exposes update / add / remove and round-trips an edit", async () => {
		let html = '<section id="working-notes"></section>';
		const tools = createMentalMapTools(
			() => html,
			(h) => {
				html = h;
			},
		);
		expect(tools.map((t) => t.name)).toEqual([
			"mental_map_update",
			"mental_map_add",
			"mental_map_remove",
		]);
		const [, add] = tools;
		const res = await add.execute("1", {
			new_id: "n1",
			parent_id: "working-notes",
			content: "<p>note</p>",
		});
		expect(res.isError).toBeUndefined();
		expect(html).toContain('id="n1"');
		expect(html).toContain("note");
	});
});
