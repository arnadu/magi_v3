/**
 * Smoke test for OpenRouter models.
 * Run with:
 *   npx tsx --import ./packages/agent-runtime-worker/dist/node-polyfill.js scripts/test-openrouter.ts
 * Requires OPENROUTER_API_KEY in .env (or environment).
 */

import { config } from "dotenv";
import { completeSimple } from "@mariozechner/pi-ai";
import { DEEPSEEK_V3_2, MINISTRAL_14B } from "../packages/agent-runtime-worker/src/models.js";

config(); // load .env

const PROMPT = "What is 2 + 2? Reply in exactly one sentence.";

async function testModel(model: typeof DEEPSEEK_V3_2 | typeof MINISTRAL_14B, label: string) {
	console.log(`\n── ${label} (${model.id}) ──`);
	const start = Date.now();
	const result = await completeSimple(model, {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: PROMPT, timestamp: Date.now() }],
		tools: [],
	});
	const elapsed = ((Date.now() - start) / 1000).toFixed(1);

	const text = result.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { type: "text"; text: string }).text)
		.join("");

	const u = result.usage;
	const cost = (u.cost.total * 1000).toFixed(4);

	console.log(`Response : ${text}`);
	console.log(`Tokens   : ${u.input} in / ${u.output} out`);
	console.log(`Cost     : $${cost} (×1000) | ${elapsed}s`);

	if (result.stopReason === "error") {
		console.error("ERROR: stop reason is 'error'");
		console.error("Full response:", JSON.stringify(result, null, 2));
		process.exit(1);
	}
}

try {
	if (!process.env.OPENROUTER_API_KEY) {
		console.error("OPENROUTER_API_KEY is not set. Add it to .env or export it.");
		process.exit(1);
	}

	await testModel(DEEPSEEK_V3_2, "DeepSeek V3.2 (main agent model)");
	await testModel(MINISTRAL_14B, "Ministral 14B (vision model)");

	console.log("\n✓ Both models responded successfully.");
} catch (err) {
	console.error("\nFATAL:", err);
	process.exit(1);
}
