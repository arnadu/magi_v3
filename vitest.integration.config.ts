import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["packages/*/tests/**/*.integration.test.ts"],
		setupFiles: ["./vitest.setup.ts"],
		// Integration tests share pool users (magi-w1/magi-w2) and MongoDB state.
		// Run files sequentially to prevent workspace and mailbox cross-contamination.
		fileParallelism: false,
	},
});
