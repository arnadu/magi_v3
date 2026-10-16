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
			exclude: ["packages/*/src/**/*.d.ts", "packages/cockpit/**"],
			// Per-package floors (issue #44), maintained by hand: set to a few tenths
			// under what CI last measured, because coverage differs slightly between a
			// developer machine and the runner (tests that skip without pool users or
			// setfacl) — `autoUpdate` wrote a local maximum here once and CI then failed
			// by 0.06 points. Raise them deliberately after a sprint's tests land
			// (read the numbers off the CI `verify` job); a drop fails `npm run verify`;
			// lowering one is the visible escape hatch (e.g. deleting well-covered
			// code), never a `?? default`.
			thresholds: {
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
