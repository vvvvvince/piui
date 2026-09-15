// Integration-test app: temp home + built Fastify instance, torn down together.
import { buildServer, type PiuiServer } from "../../src/http/server.js";
import { type MintedPrincipal, type MintOptions, mintPrincipal } from "./principal.js";
import { createTempHome, type TempHome, type TempHomeOptions } from "./temp-home.js";

export interface TestApp extends TempHome {
	app: PiuiServer;
	/** Opens a session for a (possibly new) user and returns ready-to-use request headers. */
	mint(options?: MintOptions): MintedPrincipal;
}

export async function createTestApp(options: TempHomeOptions = {}): Promise<TestApp> {
	const home = createTempHome(options);
	const app = await buildServer(home.ctx);
	await app.ready();
	return {
		...home,
		app,
		mint: (options: MintOptions = {}) => mintPrincipal(home.ctx, options),
		cleanup() {
			void app.close();
			home.cleanup();
		},
	};
}

export async function withTestApp<T>(
	fn: (app: TestApp) => Promise<T> | T,
	options: TempHomeOptions = {},
): Promise<T> {
	const app = await createTestApp(options);
	try {
		return await fn(app);
	} finally {
		app.cleanup();
	}
}
