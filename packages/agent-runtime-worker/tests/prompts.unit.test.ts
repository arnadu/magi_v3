import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPrompt, type PromptFile } from "../src/prompts.js";

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

describe("loadPrompt", () => {
	it("fills the given placeholders once, inserting values literally", () => {
		const text = loadPrompt("mission-copilot.md", {
			missionId: "m-1",
			missionName: "Has {{roster}} and $& in it",
			roster: "- lead: {{missionId}}",
		});
		expect(text).toContain("mission `m-1`");
		expect(text).toContain('("Has {{roster}} and $& in it")');
		expect(text).toContain("- lead: {{missionId}}");
	});

	it("leaves placeholders it was not given for a later stage", () => {
		const text = loadPrompt("mission-copilot.md", {
			missionId: "m",
			missionName: "n",
			roster: "r",
		});
		expect(text).toContain("{{mentalMap}}");
		expect(text).toContain("{{sharedDir}}");
	});

	it("refuses a var the file has no placeholder for", () => {
		expect(() => loadPrompt("reflection.md", { sharedDir: "/x" })).toThrow(
			/reflection\.md has no placeholder for \{\{sharedDir\}\}/,
		);
	});

	it("drops the file's trailing newline", () => {
		const raw = readFileSync(join(PROMPTS_DIR, "browse-agent.md"), "utf8");
		expect(loadPrompt("browse-agent.md")).toBe(raw.slice(0, -1));
	});

	it("has a file for every prompt name, and a name for every prompt file", () => {
		const names: PromptFile[] = [
			"browse-agent.md",
			"image-describe.md",
			"image-ocr.md",
			"image-page-visual.md",
			"mental-map-pointer.md",
			"mission-copilot-mental-map.html",
			"mission-copilot.md",
			"reflection.md",
			"rendering-note.md",
			"research-context-only.md",
			"research.md",
		];
		const files = readdirSync(PROMPTS_DIR).filter((f) => f !== "README.md");
		expect(files.sort()).toEqual([...names].sort());
		for (const n of names) expect(loadPrompt(n).length).toBeGreaterThan(0);
	});
});
