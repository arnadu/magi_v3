/**
 * One small live generation per image menu model (ADR-0035): the expected
 * format comes back, the recorded cost is above zero, and an abort stops a
 * call. Costs about $0.60 per run (Recraft pro vector is $0.30 alone);
 * skipped without OPENROUTER_API_KEY. Run it after a pi-ai upgrade or a
 * menu change.
 */

import { describe, expect, it } from "vitest";
import { generateImage } from "../src/images/image-client.js";
import { IMAGE_MENU } from "../src/images/image-models.js";

const live = Boolean(process.env.OPENROUTER_API_KEY);
const PROMPT =
	"A single green leaf icon, flat, centred on a plain white background.";

describe.skipIf(!live)("image menu models (live)", () => {
	for (const entry of IMAGE_MENU) {
		it(`${entry.id} returns ${entry.output} at a cost above zero`, async () => {
			const r = await generateImage({
				modelId: entry.id,
				prompt: PROMPT,
				aspectRatio: "1:1",
			});
			expect(r.images.length).toBeGreaterThan(0);
			const mime = r.images[0].mimeType;
			if (entry.output === "svg") expect(mime).toBe("image/svg+xml");
			else expect(mime).not.toBe("image/svg+xml");
			expect(r.costUsd).toBeGreaterThan(0);
			// A reported charge is the normal case; the ceiling is a fallback.
			expect(r.costUsd).toBeLessThanOrEqual(entry.ceilingUsdPerImage);
		}, 180_000);
	}

	it("stops a generation when the caller aborts", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 200);
		await expect(
			generateImage({
				modelId: "black-forest-labs/flux.2-pro",
				prompt: PROMPT,
				signal: ac.signal,
			}),
		).rejects.toThrow(/aborted/);
	}, 60_000);
});
