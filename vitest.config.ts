import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

const alias = { "@piui/shared": fileURLToPath(new URL("./shared/src/index.ts", import.meta.url)) };

export default defineConfig({
	test: {
		globalSetup: ["./test/setup/global-setup.ts"],
		projects: [
			{
				resolve: { alias },
				test: {
					name: "unit",
					root,
					environment: "node",
					include: ["server/test/unit/**/*.test.ts", "test/*.test.ts"],
					setupFiles: ["./test/setup/server-setup.ts"],
					testTimeout: 10_000,
				},
			},
			{
				resolve: { alias },
				test: {
					name: "integration",
					root,
					environment: "node",
					include: ["server/test/integration/**/*.test.ts"],
					setupFiles: ["./test/setup/server-setup.ts"],
					testTimeout: 30_000,
				},
			},
			{
				resolve: { alias },
				test: {
					name: "client",
					root,
					environment: "jsdom",
					include: ["client/src/**/*.test.{ts,tsx}"],
					setupFiles: ["./test/setup/client-setup.ts"],
					testTimeout: 10_000,
				},
			},
		],
	},
});
