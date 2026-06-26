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
	},
});
