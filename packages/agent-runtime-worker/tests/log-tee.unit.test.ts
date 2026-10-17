import {
	existsSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rotateIfLarge } from "../src/daemon-boot/log-tee.js";

const dir = mkdtempSync(join(tmpdir(), "magi-logtee-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("rotateIfLarge (LG1)", () => {
	it("leaves a small log alone and reports false for a missing one", () => {
		const p = join(dir, "small.log");
		writeFileSync(p, "hello");
		expect(rotateIfLarge(p, 1024)).toBe(false);
		expect(rotateIfLarge(join(dir, "nope.log"), 1024)).toBe(false);
	});

	it("renames a log at or above the limit to .1 and lets a fresh one start", () => {
		const p = join(dir, "big.log");
		writeFileSync(p, "x".repeat(2048));
		expect(rotateIfLarge(p, 1024)).toBe(true);
		expect(existsSync(p)).toBe(false);
		expect(statSync(`${p}.1`).size).toBe(2048);
		// A second rotation overwrites the single kept copy — bounded disk use.
		writeFileSync(p, "y".repeat(4096));
		expect(rotateIfLarge(p, 1024)).toBe(true);
		expect(statSync(`${p}.1`).size).toBe(4096);
	});
});
