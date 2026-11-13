import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildRequest,
	createCreateImageTool,
	PLATFORM_MAX_IMAGES,
	PLATFORM_MAX_USD,
	tryCreateCreateImageTool,
} from "../src/images/create-image-tool.js";
import type { GenerateImageRequest } from "../src/images/image-client.js";
import { ImageJob } from "../src/images/image-job.js";
import { CLAUDE_SONNET } from "../src/models.js";

const PNG = Buffer.from("iVBORw0KGgo=", "base64");
let root: string;
let workdir: string;
let shared: string;
let outside: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "create-image-"));
	workdir = join(root, "work");
	shared = join(root, "shared");
	outside = join(root, "outside");
	for (const d of [workdir, shared, outside]) mkdirSync(d);
	writeFileSync(join(workdir, "style.png"), PNG);
	writeFileSync(join(outside, "secret.png"), PNG);
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const finishOnly = async (): Promise<AssistantMessage> =>
	({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "f",
				name: "finish",
				arguments: { summary: "nothing made" },
			},
		],
		api: "openai-completions",
		provider: "openrouter",
		model: "x",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	}) as AssistantMessage;

function tool(
	over: Partial<Parameters<typeof createCreateImageTool>[0]> = {},
	generated: GenerateImageRequest[] = [],
) {
	return createCreateImageTool({
		agentModel: CLAUDE_SONNET,
		workdir,
		sharedDir: shared,
		agentId: "designer",
		renderPreviews: null,
		completeFn: finishOnly,
		generate: async (req) => {
			generated.push(req);
			throw new Error("not used");
		},
		...over,
	});
}

const text = (r: { content: { text: string }[] }) =>
	r.content.map((c) => c.text).join("");

describe("CreateImage arguments", () => {
	it("requires a brief, an enabled kind, and refineJob with refineCandidate", async () => {
		const t = tool({ allowedKinds: ["raster-art"] });
		expect((await t.execute("1", { brief: " " })).isError).toBe(true);
		const kind = await t.execute("1", { brief: "b", kind: "vector" });
		expect(text(kind)).toMatch(/not enabled/);
		const half = await t.execute("1", { brief: "b", refineJob: "img-x" });
		expect(text(half)).toMatch(/go together/);
	});

	it("caps the budget overrides at the platform limits", () => {
		const r = buildRequest(
			{ brief: " b ", maxImages: 999, maxUsd: 999, options: 50 },
			[],
		);
		expect(r).toMatchObject({
			brief: "b",
			maxImages: PLATFORM_MAX_IMAGES,
			maxUsd: PLATFORM_MAX_USD,
			options: 6,
		});
		expect(buildRequest({ brief: "b" }, [])).toMatchObject({
			maxImages: 8,
			maxUsd: 1.5,
			options: 3,
		});
	});
});

describe("CreateImage references", () => {
	it("refuses a reference outside the workdir and the shared folder, or through a symlink", async () => {
		const t = tool();
		const out = await t.execute("1", {
			brief: "b",
			references: [join(outside, "secret.png")],
		});
		expect(text(out)).toMatch(/outside your workdir/);
		symlinkSync(join(outside, "secret.png"), join(workdir, "link.png"));
		const link = await t.execute("1", {
			brief: "b",
			references: ["link.png"],
		});
		expect(link.isError).toBe(true);
	});

	it("refuses a non-image reference and an unknown job to refine", async () => {
		writeFileSync(join(workdir, "notes.txt"), "x");
		const t = tool();
		expect(
			text(await t.execute("1", { brief: "b", references: ["notes.txt"] })),
		).toMatch(/PNG, JPEG or WebP/);
		expect(
			text(
				await t.execute("1", {
					brief: "b",
					refineJob: "../../etc",
					refineCandidate: 1,
				}),
			),
		).toMatch(/not an image job id/);
	});

	it("passes the caller's reference and the candidate to refine to the image agent", async () => {
		const prev = ImageJob.create(
			shared,
			{
				createdBy: "designer",
				brief: "first",
				options: 1,
				budget: { maxImages: 8, maxUsd: 1.5 },
			},
			"img-20261113-0123456789abcdef",
		);
		prev.addCandidate(
			{ mimeType: "image/png", bytes: PNG },
			{
				model: "black-forest-labs/flux.2-pro",
				prompt: "p",
				references: [],
				costUsd: 0.03,
				costEstimated: false,
			},
		);
		let task = "";
		const t = tool({
			completeFn: async (_m, ctx) => {
				const first = ctx.messages[0];
				if (first?.role === "user" && typeof first.content === "string") {
					task = first.content;
				}
				return finishOnly();
			},
		});
		const out = await t.execute("1", {
			brief: "make the leaf gold",
			references: ["style.png"],
			refineJob: prev.manifest.jobId,
			refineCandidate: 1,
		});
		expect(task).toContain("`ref-1`: style.png (image/png)");
		expect(task).toContain(
			`\`parent\`: candidate 1 of job ${prev.manifest.jobId}`,
		);
		// Nothing made: the job failed, and says so.
		expect(out.isError).toBe(true);
		expect(text(out)).toMatch(/failed/);
	});
});

describe("CreateImage turn spend", () => {
	it("reports the images spent this turn, adding up across calls", async () => {
		const t = tool();
		const first = text(await t.execute("1", { brief: "a leaf" }));
		expect(first).toMatch(
			/Spent on images this turn: \$\d+\.\d\d across 1 job\(s\)/,
		);
		const second = text(await t.execute("2", { brief: "a fern" }));
		expect(second).toMatch(/across 2 job\(s\)/);
	});
});

describe("tryCreateCreateImageTool", () => {
	it("offers the tool only when OpenRouter is configured", () => {
		const opts = {
			agentModel: CLAUDE_SONNET,
			workdir,
			sharedDir: shared,
			agentId: "a",
		};
		vi.stubEnv("OPENROUTER_API_KEY", "");
		expect(tryCreateCreateImageTool(opts)).toBeUndefined();
		vi.stubEnv("OPENROUTER_API_KEY", "k");
		expect(tryCreateCreateImageTool(opts)?.name).toBe("CreateImage");
	});
});
