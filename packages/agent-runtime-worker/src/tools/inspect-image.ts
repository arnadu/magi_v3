import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model, UserMessage } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "../tools.js";

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

const EXT_TO_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
};

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
 * agent, and returns the model's description. The path is resolved relative
 * to `workdir`, so agents can pass paths like `"artifacts/<id>/image-0.jpg"`.
 *
 * The model must advertise `input: ["image"]` capability (CLAUDE_SONNET does).
 * If the model lacks vision capability the tool returns an error rather than
 * throwing so the agent can handle the failure gracefully.
 */
export function createInspectImageTool(
	workdir: string,
	model: Model<string>,
): MagiTool {
	return {
		name: "InspectImage",
		description:
			"Analyse an image file with the vision LLM and return a detailed description. " +
			"The path is relative to the working directory, e.g. " +
			'"artifacts/<id>/image-0.jpg" or "uploads/<id>/photo.png". ' +
			"Optionally supply a focused prompt to direct the analysis.",
		parameters: Type.Object({
			path: Type.String({
				description:
					"Relative path to the image file (jpg, jpeg, png, gif, webp, avif)",
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
			let imageBytes: Buffer;
			try {
				imageBytes = await readFile(join(workdir, imagePath));
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
				const response = await completeSimple(
					model,
					{ messages: [message] },
					{ signal },
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
