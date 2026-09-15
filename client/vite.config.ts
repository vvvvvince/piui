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
			"/api": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: false },
		},
	},
	build: { outDir: "dist", sourcemap: true },
});
