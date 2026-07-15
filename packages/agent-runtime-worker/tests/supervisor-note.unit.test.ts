/**
 * Supervisor note — daemon-managed #supervisor-note mental-map region
 * (ADR-0016). File-based under sharedDir; no MongoDB.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readSupervisorNote,
	renderSupervisorNote,
	writeSupervisorNote,
} from "../src/supervisor-note.js";

describe("supervisor-note", () => {
	let shared: string;

	beforeEach(() => {
		shared = mkdtempSync(join(tmpdir(), "supervisor-note-"));
	});
	afterEach(() => {
		rmSync(shared, { recursive: true, force: true });
	});

	it("returns null when no note exists", async () => {
		expect(await readSupervisorNote(shared, "worker")).toBeNull();
	});

	it("round-trips a written note", async () => {
		await writeSupervisorNote(
			shared,
			"worker",
			"Check your objective again.",
			"mission-copilot",
		);
		const entry = await readSupervisorNote(shared, "worker");
		expect(entry?.note).toBe("Check your objective again.");
		expect(entry?.by).toBe("mission-copilot");
		expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("the latest write replaces the previous note (not appended)", async () => {
		await writeSupervisorNote(
			shared,
			"worker",
			"first note",
			"mission-copilot",
		);
		await writeSupervisorNote(
			shared,
			"worker",
			"second note",
			"mission-copilot",
		);
		const entry = await readSupervisorNote(shared, "worker");
		expect(entry?.note).toBe("second note");
	});

	it("notes are scoped per agent", async () => {
		await writeSupervisorNote(
			shared,
			"worker-a",
			"note for a",
			"mission-copilot",
		);
		expect(await readSupervisorNote(shared, "worker-b")).toBeNull();
	});

	it("degrades to null on a corrupt note file instead of throwing", async () => {
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(join(shared, "supervisor-notes"), { recursive: true });
		await writeFile(
			join(shared, "supervisor-notes", "worker.json"),
			"not json",
			"utf8",
		);
		expect(await readSupervisorNote(shared, "worker")).toBeNull();
	});

	it("renders HTML that escapes the note and author", () => {
		const html = renderSupervisorNote({
			note: "Check <script>alert(1)</script> & fix it",
			by: "mission-copilot",
			at: "2026-07-14T00:00:00.000Z",
		});
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&amp;");
	});
});
