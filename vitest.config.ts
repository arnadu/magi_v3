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
			// Per-package ratchet (issue #44, audit remediation M0): thresholds sit one
			// point under the 2026-10-16 baseline and `autoUpdate` rewrites them upward
			// when coverage improves — commit the bump. They are a floor against
			// regression, not a target; raise deliberately with new tests.
			thresholds: {
				autoUpdate: true,
				"packages/agent-config/src/**": {
					statements: 93.25,
					branches: 92.3,
					functions: 87.5,
				},
				"packages/agent-runtime-worker/src/**": {
					statements: 48.29,
					branches: 81.67,
					functions: 68.19,
				},
				"packages/control-plane/src/**": {
					statements: 46.06,
					branches: 86.58,
					functions: 72.22,
				},
			},
		},
	},
});
