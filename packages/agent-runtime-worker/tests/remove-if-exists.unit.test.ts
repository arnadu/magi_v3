import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeIfExists } from "../src/remove-if-exists.js";

describe("removeIfExists", () => {
	it("removes the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "rie-"));
		const f = join(dir, "x");
		writeFileSync(f, "x");
		removeIfExists(f, "unused");
		expect(existsSync(f)).toBe(false);
	});

	it("is silent when the file is already gone", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		removeIfExists(join(tmpdir(), "rie-does-not-exist"), "unused");
		expect(err).not.toHaveBeenCalled();
		err.mockRestore();
	});

	it("logs any other failure with what it leaves behind", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const dir = mkdtempSync(join(tmpdir(), "rie-"));
		removeIfExists(dir, "a directory is left behind");
		expect(err.mock.calls[0][0]).toContain("a directory is left behind");
		err.mockRestore();
	});
});
