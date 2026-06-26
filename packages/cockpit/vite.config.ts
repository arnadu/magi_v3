import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The cockpit is served by the control plane as static files under /cockpit/.
// Building into control-plane/public/cockpit keeps deployment a single artifact;
// the existing dashboard (public/index.html + Firebase login) is left untouched.
export default defineConfig({
	plugins: [react()],
	base: "/cockpit/",
	build: {
		outDir: "../control-plane/public/cockpit",
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
