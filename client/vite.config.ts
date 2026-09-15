import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: { "@piui/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
	},
	server: {
		port: 5173,
		proxy: {
			// changeOrigin must stay false: the CSRF check compares Origin against Host
			// (spec/06-auth.md §5), and rewriting Host to the target breaks that in dev.
			"/api": { target: "http://127.0.0.1:8787", changeOrigin: false, ws: false },
		},
	},
	build: { outDir: "dist", sourcemap: true },
});
