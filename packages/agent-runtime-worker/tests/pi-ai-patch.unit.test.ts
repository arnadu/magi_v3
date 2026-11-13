/**
 * MAGI patches pi-ai (patches/@mariozechner+pi-ai+*.patch, applied by
 * postinstall) so OpenRouter's reported charge reaches the meter as
 * `usage.providerCost`. A dependency upgrade that drops the patch would make
 * every OpenRouter call fall back to registry prices, and per-image models
 * are priced $0 there (ADR-0035 decision 9): this test fails first.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// pi-ai's exports map hides its files from require.resolve; search the same
// node_modules directories Node would, nearest first.
const require = createRequire(import.meta.url);
const piAiDist = (require.resolve.paths("@mariozechner/pi-ai") ?? [])
	.map((dir) => join(dir, "@mariozechner/pi-ai/dist"))
	.find((dir) => existsSync(dir));

describe("pi-ai provider-cost patch", () => {
	for (const file of ["api/openai-completions", "api/openrouter-images"]) {
		it(`surfaces usage.cost as providerCost in ${file}.js`, () => {
			expect(piAiDist).toBeDefined();
			const src = readFileSync(join(piAiDist ?? "", `${file}.js`), "utf8");
			expect(src).toContain("providerCost: rawUsage.cost");
		});
	}
});
