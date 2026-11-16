import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRegionSchema } from "@magi/agent-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncFileRegions } from "../src/mental-map-regions.js";

const MAP = '<section id="notes"><h2>Notes</h2><p>mine</p></section>';
const NOW = new Date("2026-11-16T12:00:00Z");

let root: string;
let shared: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "regions-"));
	shared = join(root, "shared");
	mkdirSync(join(shared, "analysis"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const agent = (regions: object[]) => ({
	id: "code-reviewer",
	managedRegions: regions.map((r) => ManagedRegionSchema.parse(r)),
});
const region = (html: string, key = "trace-todo") => {
	const m = html.match(
		new RegExp(`<section data-managed="${key}">([\\s\\S]*?)</section>`),
	);
	return m ? m[1] : null;
};
const write = (rel: string, text: string, hoursAgo = 1) => {
	const p = join(shared, rel);
	writeFileSync(p, text);
	const t = new Date(NOW.getTime() - hoursAgo * 3_600_000);
	utimesSync(p, t, t);
};

describe("file-fed mental-map regions", () => {
	it("leaves a map alone when the agent has no regions", () => {
		expect(syncFileRegions({ id: "a" }, "m", shared, MAP, NOW)).toBeNull();
	});

	it("shows the file as escaped text, labelled as data, keeping the agent's sections", () => {
		write("analysis/todo.md", "- fix <script>alert(1)</script> & more");
		const html = syncFileRegions(
			agent([
				{ key: "trace-todo", title: "Trace to-do", file: "analysis/todo.md" },
			]),
			"m",
			shared,
			MAP,
			NOW,
		) as string;
		const r = region(html) as string;
		expect(r).toContain("Trace to-do");
		expect(r).toContain("not instructions");
		expect(r).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
		expect(r).not.toContain("<script>");
		expect(r).not.toContain("Stale");
		expect(html).toContain('<section id="notes">');
	});

	it("says when the file does not exist yet", () => {
		const html = syncFileRegions(
			agent([{ key: "trace-todo", file: "analysis/none.md" }]),
			"m",
			shared,
			MAP,
			NOW,
		) as string;
		expect(region(html)).toContain("does not exist");
	});

	it("marks an old file stale", () => {
		write("analysis/todo.md", "old", 30);
		const html = syncFileRegions(
			agent([
				{ key: "trace-todo", file: "analysis/todo.md", staleAfterHours: 24 },
			]),
			"m",
			shared,
			MAP,
			NOW,
		) as string;
		expect(region(html)).toContain("Stale: older than 24 hours");
	});

	it("cuts a file larger than maxBytes and says so", () => {
		write("analysis/todo.md", "x".repeat(2000));
		const html = syncFileRegions(
			agent([{ key: "trace-todo", file: "analysis/todo.md", maxBytes: 300 }]),
			"m",
			shared,
			MAP,
			NOW,
		) as string;
		const r = region(html) as string;
		expect(r).toContain("Cut at 300 bytes");
		expect(r.match(/x+/)?.[0].length).toBe(300);
	});

	it("refuses a symlink that leads outside the shared folder", () => {
		writeFileSync(join(root, "secret.txt"), "the daemon's secret");
		symlinkSync(join(root, "secret.txt"), join(shared, "analysis/todo.md"));
		const html = syncFileRegions(
			agent([{ key: "trace-todo", file: "analysis/todo.md" }]),
			"m",
			shared,
			MAP,
			NOW,
		) as string;
		const r = region(html) as string;
		expect(r).toContain("Not shown");
		expect(r).not.toContain("secret");
	});

	it("re-renders the region on the next turn instead of adding another", () => {
		write("analysis/todo.md", "first");
		const a = agent([{ key: "trace-todo", file: "analysis/todo.md" }]);
		const once = syncFileRegions(a, "m", shared, MAP, NOW) as string;
		write("analysis/todo.md", "second");
		const twice = syncFileRegions(a, "m", shared, once, NOW) as string;
		expect(twice.match(/data-managed="trace-todo"/g)).toHaveLength(1);
		expect(region(twice)).toContain("second");
	});

	it("rejects a region that could escape the shared folder or take the objectives key", () => {
		expect(() =>
			ManagedRegionSchema.parse({ key: "x", file: "../workdir/a.md" }),
		).toThrow();
		expect(() =>
			ManagedRegionSchema.parse({ key: "x", file: "/etc/passwd" }),
		).toThrow();
		expect(() =>
			ManagedRegionSchema.parse({ key: "my-objectives", file: "a.md" }),
		).toThrow();
		expect(() =>
			ManagedRegionSchema.parse({ key: "Bad Key", file: "a.md" }),
		).toThrow();
	});
});
