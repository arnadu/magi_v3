import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Unit tests only — integration tests require a live API key and are run separately.
		include: ["packages/*/tests/**/*.test.ts"],
		exclude: ["packages/*/tests/**/*.integration.test.ts", "node_modules"],
		passWithNoTests: true,
		setupFiles: ["./vitest.setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			include: ["packages/*/src/**/*.ts"],
			// The cockpit counts only its pure modules: components (.tsx) and hooks
			// need React and a DOM this node suite does not run, auth needs
			// Firebase, the API client a server, and type-only files have no code.
			exclude: [
				"packages/*/src/**/*.d.ts",
				"packages/cockpit/src/**/*.tsx",
				"packages/cockpit/src/**/use-*.ts",
				"packages/cockpit/src/app-hooks.ts",
				"packages/cockpit/src/auth.ts",
				"packages/cockpit/src/api/**",
				"packages/cockpit/src/data.ts",
				"packages/cockpit/src/types.ts",
				"packages/cockpit/src/llm-call-types.ts",
			],
			// Per-package floors (issue #44), maintained by hand: set to a few tenths
			// under what CI last measured, because coverage differs slightly between a
			// developer machine and the runner (tests that skip without pool users or
			// setfacl) — `autoUpdate` wrote a local maximum here once and CI then failed
			// by 0.06 points. Raise them deliberately after a sprint's tests land
			// (read the numbers off the CI `verify` job); a drop fails `npm run verify`;
			// lowering one is the visible escape hatch (e.g. deleting well-covered
			// code), never a `?? default`.
			thresholds: {
				"packages/cockpit/src/**": {
					statements: 97.6,
					branches: 90.9,
					functions: 89,
				},
				"packages/agent-config/src/**": {
					statements: 93,
					branches: 92,
					functions: 87,
				},
				"packages/agent-runtime-worker/src/**": {
					statements: 51.5,
					branches: 81.3,
					functions: 70.1,
				},
				"packages/control-plane/src/**": {
					statements: 47.2,
					branches: 87.5,
					functions: 73,
				},
			},
		},
	},
});
