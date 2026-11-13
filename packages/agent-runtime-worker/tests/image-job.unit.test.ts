import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	contactSheetHtml,
	ImageJob,
	JOB_ID_RE,
	newJobId,
	readJobCandidate,
	readJobManifest,
} from "../src/images/image-job.js";

let shared: string;
let outside: string;
beforeEach(() => {
	shared = mkdtempSync(join(tmpdir(), "img-job-"));
	outside = mkdtempSync(join(tmpdir(), "img-outside-"));
});
afterEach(() => {
	rmSync(shared, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

const init = {
	createdBy: "designer",
	brief: "brief",
	options: 2,
	budget: { maxImages: 8, maxUsd: 1.5 },
};
const ID = "img-20261113-0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgo=", "base64");

describe("image job folder", () => {
	it("makes unguessable ids of a fixed shape", () => {
		const a = newJobId(new Date("2026-11-13T00:00:00Z"));
		expect(a).toMatch(JOB_ID_RE);
		expect(a.startsWith("img-20261113-")).toBe(true);
		expect(newJobId()).not.toBe(newJobId());
	});

	it("refuses a job folder that already exists or is a planted symlink", () => {
		mkdirSync(join(shared, "images", ID), { recursive: true });
		expect(() => ImageJob.create(shared, init, ID)).toThrow(/EEXIST/);
		const other = "img-20261113-fedcba9876543210";
		symlinkSync(outside, join(shared, "images", other));
		expect(() => ImageJob.create(shared, init, other)).toThrow();
	});

	it("refuses a planted images/ symlink that leaves the shared folder", () => {
		symlinkSync(outside, join(shared, "images"));
		expect(() => ImageJob.create(shared, init, ID)).toThrow();
	});

	it("does not write a manifest through a planted symlink", () => {
		const job = ImageJob.create(shared, init, ID);
		const manifest = join(job.dir, "manifest.json");
		rmSync(manifest);
		const target = join(outside, "victim");
		writeFileSync(target, "untouched");
		symlinkSync(target, manifest);
		expect(() => job.save()).toThrow(/symlink/);
		expect(readFileSync(target, "utf8")).toBe("untouched");
	});

	it("reads candidates by number, never by a file name from the manifest", () => {
		const job = ImageJob.create(shared, init, ID);
		job.addCandidate(
			{ mimeType: "image/png", bytes: PNG },
			{
				model: "m",
				prompt: "p",
				references: [],
				costUsd: 0.03,
				costEstimated: false,
			},
		);
		const m = readJobManifest(shared, ID);
		m.candidates[0].file = "../../../etc/passwd";
		expect(readJobCandidate(shared, m, 1).bytes).toEqual(PNG);
		expect(() => readJobCandidate(shared, m, 2)).toThrow(/no candidate 2/);
		expect(() => readJobManifest(shared, "../x")).toThrow(
			/not an image job id/,
		);
	});

	it("contact sheet escapes every caption and never inlines SVG", () => {
		const job = ImageJob.create(
			shared,
			{ ...init, brief: '<script>alert("brief")</script>' },
			ID,
		);
		job.addCandidate(
			{ mimeType: "image/svg+xml", bytes: Buffer.from("<svg onload=x>") },
			{
				model: "m<b>",
				prompt: "</pre><img src=x onerror=alert(1)>",
				rationale: "<i>why</i>",
				references: [],
				costUsd: 0.08,
				costEstimated: true,
			},
		);
		job.manifest.summary = "<script>s</script>";
		const html = contactSheetHtml(
			job.manifest,
			new Map([[1, Buffer.from("jpeg")]]),
		);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;script&gt;alert(&quot;brief&quot;)");
		expect(html).toContain("data:image/jpeg;base64,");
		expect(html).toContain("(estimated)");
	});

	it("embeds a small raster original when no preview exists, and names the file otherwise", () => {
		const job = ImageJob.create(shared, init, ID);
		const meta = {
			model: "m",
			prompt: "p",
			references: [],
			costUsd: 0.1,
			costEstimated: false,
		};
		job.addCandidate({ mimeType: "image/png", bytes: PNG }, meta);
		job.addCandidate(
			{ mimeType: "image/svg+xml", bytes: Buffer.from("<svg/>") },
			meta,
		);
		const rel = job.writeContactSheet(new Map());
		const html = readFileSync(join(shared, rel), "utf8");
		expect(html).toContain("data:image/png;base64,");
		expect(html).toContain("No preview: open candidate-2.svg");
		expect(job.manifest.totals).toMatchObject({ images: 2, totalUsd: 0.2 });
	});
});
