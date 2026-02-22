import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["packages/*/tests/**/*.integration.test.ts"],
		setupFiles: ["./vitest.setup.ts"],
	},
});
