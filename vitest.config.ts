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
			reporter: ["text", "html", "json-summary"],
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
			// (the CI `verify` job prints per-package totals after the coverage run —
			// scripts/audit/coverage-totals.mjs); a drop fails `npm run verify`;
			// lowering one is the visible escape hatch (e.g. deleting well-covered
			// code), never a `?? default`.
			thresholds: {
				// Risk-weighted floors (#44): the modules that enforce path containment,
				// SSRF, spend limits and authentication stay near-fully covered.
				"packages/agent-runtime-worker/src/{safe-path,ssrf,safe-http,limits}.ts":
					{ statements: 90 },
				"packages/control-plane/src/{spend-policy,auth-limiter,copilot-spend,usage-queries}.ts":
					{ statements: 90 },
				"packages/cockpit/src/**": {
					statements: 97.8,
					branches: 91,
					functions: 89,
				},
				"packages/agent-config/src/**": {
					statements: 95.4,
					branches: 95.4,
					functions: 91,
				},
				"packages/agent-runtime-worker/src/**": {
					statements: 61.7,
					branches: 82.6,
					functions: 78.2,
				},
				"packages/control-plane/src/**": {
					statements: 57.6,
					branches: 88.6,
					functions: 74.8,
				},
			},
		},
	},
});
