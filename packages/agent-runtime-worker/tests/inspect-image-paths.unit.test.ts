/**
 * InspectImage's base matching (INSP1 / safe-path.ts): which permitted base an
 * image path falls under, physically — and "missing" distinguished from
 * "outside" so the tool's error says the right thing.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPermittedBase } from "../src/tools/inspect-image.js";

let base: string;
let workdir: string;
let shared: string;
let outside: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "inspect-paths-")));
	workdir = join(base, "workdir");
	shared = join(base, "shared");
	outside = join(base, "outside");
	for (const d of [workdir, shared, outside]) mkdirSync(d);
	writeFileSync(join(shared, "chart.png"), "png");
	writeFileSync(join(outside, "secret.png"), "png");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("findPermittedBase", () => {
	it("returns the base an existing file is inside of", () => {
		expect(
			findPermittedBase([workdir, shared], join(shared, "chart.png")),
		).toEqual({
			base: shared,
			missing: false,
		});
	});

	it("reports a path that exists under no base as outside, not missing", () => {
		expect(
			findPermittedBase([workdir, shared], join(outside, "secret.png")),
		).toEqual({
			missing: false,
		});
	});

	it("reports a path that would be inside but does not exist as missing", () => {
		expect(
			findPermittedBase([workdir, shared], join(shared, "nope.png")),
		).toEqual({
			missing: true,
		});
	});

	it("sees through a symlink planted inside a base that points outside", () => {
		symlinkSync(join(outside, "secret.png"), join(workdir, "img.png"));
		expect(
			findPermittedBase([workdir, shared], join(workdir, "img.png")),
		).toEqual({
			missing: false,
		});
	});
});
