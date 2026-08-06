import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The cockpit is served by the control plane as static files at the root —
// it's the only UI (Sprint 27 retired the legacy public/index.html dashboard).
// Building straight into control-plane/public keeps deployment a single artifact.
export default defineConfig({
	plugins: [react()],
	base: "/",
	build: {
		outDir: "../control-plane/public",
		emptyOutDir: true,
		// Stable (un-hashed) filenames: the build output is committed and served
		// with Cache-Control: no-store, so content-hash busting isn't needed and
		// stable names keep the committed diff clean across rebuilds.
		rollupOptions: {
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
});
