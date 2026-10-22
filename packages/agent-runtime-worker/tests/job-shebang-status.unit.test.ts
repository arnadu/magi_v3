import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readShebangInterpreter } from "../src/job-runner.js";
import { finishedJobStatus } from "../src/mission-copilot-diagnostics-tools.js";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function script(firstLine: string): string {
	dir ??= mkdtempSync(join(tmpdir(), "magi-shebang-"));
	const p = join(dir, `s${Math.random()}.sh`);
	writeFileSync(p, `${firstLine}\necho hi\n`);
	return p;
}

describe("readShebangInterpreter (#85)", () => {
	it("keeps the env indirection so PATH resolves the interpreter", () => {
		expect(readShebangInterpreter(script("#!/usr/bin/env bash"))).toEqual([
			"/usr/bin/env",
			"bash",
		]);
		expect(readShebangInterpreter(script("#!/usr/bin/env python3"))).toEqual([
			"/usr/bin/env",
			"python3",
		]);
	});

	it("uses a direct interpreter path as-is, and nothing without a shebang", () => {
		expect(readShebangInterpreter(script("#!/bin/bash -e"))).toEqual([
			"/bin/bash",
		]);
		expect(readShebangInterpreter(script("echo no shebang"))).toEqual([]);
		expect(readShebangInterpreter("/nonexistent/script.sh")).toEqual([]);
	});
});

describe("finishedJobStatus (MC9)", () => {
	it("tells a cancelled job from a failed one", () => {
		expect(finishedJobStatus({ exitCode: -1, cancelled: true })).toBe(
			"cancelled",
		);
		expect(finishedJobStatus({ exitCode: 0 })).toBe("completed");
		expect(finishedJobStatus({ exitCode: 1 })).toBe("failed");
	});
});
