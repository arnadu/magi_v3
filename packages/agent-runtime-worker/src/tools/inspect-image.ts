import { resolve } from "node:path";
import type { Model, UserMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { type LlmCallMeter, meteredCompleteSimple } from "../llm-meter.js";
import { EXT_TO_MIME } from "../mime-types.js";
import { PathNotFoundError, readInside, resolveInside } from "../safe-path.js";
import type { MagiTool, ToolResult } from "../tools.js";

/** Largest image the tool will base64 into a vision request. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * The first base an existing `path` is physically inside of (safe-path.ts
 * semantics), or why none matched: `missing` when the path simply does not
 * exist under any base, so the tool can say that instead of "outside".
 */
export function findPermittedBase(
	bases: string[],
	path: string,
): { base?: string; missing: boolean } {
	let missing = false;
	for (const base of bases) {
		try {
			resolveInside(base, path, { mustExist: true });
			return { base, missing: false };
		} catch (e) {
			if (e instanceof PathNotFoundError) missing = true;
		}
	}
	return { missing };
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

/** Return a supported image MIME type from a file extension, or null. */
function mimeFromPath(imagePath: string): string | null {
	const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
	return EXT_TO_MIME[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the InspectImage tool.
 *
 * Reads an image from disk, sends it to the vision-capable LLM used by the
 * agent, and returns the model's description. The path may be absolute or
 * relative (resolved against `workdir`). Absolute paths must fall under
 * `workdir` or one of the `allowedDirs` (e.g. the mission's shared dir).
 *
 * The model must advertise `input: ["image"]` capability (CLAUDE_SONNET does).
 * If the model lacks vision capability the tool returns an error rather than
 * throwing so the agent can handle the failure gracefully.
 */
export function createInspectImageTool(
	workdir: string,
	model: Model<string>,
	allowedDirs: string[] = [],
	meter?: LlmCallMeter,
): MagiTool {
	return {
		name: "InspectImage",
		description:
			"Analyse an image file with the vision LLM and return a detailed description. " +
			"Supply the absolute path returned by FetchUrl, e.g. " +
			'"/missions/<id>/shared/artifacts/<id>/image-0.jpg". ' +
			"Optionally supply a focused prompt to direct the analysis.",
		parameters: Type.Object({
			path: Type.String({
				description:
					"Absolute path to the image file (jpg, jpeg, png, gif, webp, avif)",
			}),
			prompt: Type.Optional(
				Type.String({
					description:
						'Question or instruction for the vision model (default: "Describe this image in detail.")',
				}),
			),
		}),

		async execute(_id, args, signal) {
			const imagePath = args.path as string;
			const userPrompt =
				(args.prompt as string | undefined) ?? "Describe this image in detail.";

			// --- Guard: path must stay within workdir or an allowedDir -----------
			// Read as the daemon: physical containment now, O_NOFOLLOW at the open.
			const resolvedPath = resolve(workdir, imagePath);
			const found = findPermittedBase(
				[resolve(workdir), ...allowedDirs.map((d) => resolve(d))],
				resolvedPath,
			);
			if (!found.base) {
				return toolErr(
					found.missing
						? `InspectImage: path "${imagePath}" does not exist or is not accessible`
						: `InspectImage: path "${imagePath}" is outside the permitted directories`,
				);
			}
			const base = found.base;

			// --- Guard: model must support images ---------------------------------
			if (!model.input.includes("image")) {
				return toolErr(
					`InspectImage: the current model (${model.id}) does not support image input.`,
				);
			}

			// --- Validate MIME type -----------------------------------------------
			const mimeType = mimeFromPath(imagePath);
			if (!mimeType) {
				return toolErr(
					`InspectImage: unsupported image extension for "${imagePath}". ` +
						"Supported: jpg, jpeg, png, gif, webp, avif.",
				);
			}

			// --- Read image -------------------------------------------------------
			// Capped: the bytes are base64'd into a vision request.
			let imageBytes: Buffer;
			try {
				const read = readInside(base, resolvedPath, {
					maxBytes: MAX_IMAGE_BYTES,
				});
				if (read.truncated) {
					return toolErr(
						`InspectImage: "${imagePath}" is ${(read.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / (1024 * 1024)} MB. Downscale or crop it first.`,
					);
				}
				imageBytes = read.bytes;
			} catch (e) {
				return toolErr(
					`InspectImage: could not read "${imagePath}" — ${(e as Error).message}`,
				);
			}

			const base64 = imageBytes.toString("base64");

			// --- Call vision LLM --------------------------------------------------
			const message: UserMessage = {
				role: "user",
				timestamp: Date.now(),
				content: [
					{ type: "text", text: userPrompt },
					{ type: "image", data: base64, mimeType },
				],
			};

			let description: string;
			try {
				const response = await meteredCompleteSimple(
					model,
					{ messages: [message] },
					{ signal },
					meter,
				);

				if (
					response.stopReason === "error" ||
					response.stopReason === "aborted"
				) {
					return toolErr(
						`InspectImage: vision LLM call failed — ${response.errorMessage ?? response.stopReason}`,
					);
				}

				// Extract all text blocks from the response
				description = response.content
					.filter((b) => b.type === "text")
					.map((b) => (b as { type: "text"; text: string }).text)
					.join("\n");

				if (!description) {
					return toolErr("InspectImage: vision model returned no text.");
				}
			} catch (e) {
				return toolErr(
					`InspectImage: LLM call error — ${(e as Error).message}`,
				);
			}

			return ok(`Image: ${imagePath}\n\n${description}`);
		},
	};
}
