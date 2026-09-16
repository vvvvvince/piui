// Integration-test app: temp home + built Fastify instance, torn down together.
import { buildServer, type PiuiServer } from "../../src/http/server.js";
import type { Services } from "../../src/services.js";
import { type MintedPrincipal, type MintOptions, mintPrincipal } from "./principal.js";
import { collectSse, type SseCollector } from "./sse.js";
import { createTempHome, type TempHome, type TempHomeOptions } from "./temp-home.js";

export interface TestApp extends TempHome {
	app: PiuiServer;
	/** Process-wide services: the pi model runtime, credentials, models, the session hub. */
	services: Services;
	/** Opens a session for a (possibly new) user and returns ready-to-use request headers. */
	mint(options?: MintOptions): MintedPrincipal;
	/** Attaches to an SSE route and collects its frames. */
	openSse(url: string, principal: MintedPrincipal): Promise<SseCollector>;
	/** Shorthand for the global channel of spec/09-api.md §9. */
	openGlobalEvents(principal: MintedPrincipal): Promise<SseCollector>;
}

export async function createTestApp(options: TempHomeOptions = {}): Promise<TestApp> {
	const home = createTempHome(options);
	const app = await buildServer(home.ctx);
	await app.ready();
	const openSse = async (url: string, principal: MintedPrincipal): Promise<SseCollector> => {
		const res = await app.inject({
			method: "GET",
			url,
			headers: principal.headers,
			payloadAsStream: true,
		});
		return collectSse(res.stream());
	};
	return {
		...home,
		app,
		services: app.piui,
		mint: (options: MintOptions = {}) => mintPrincipal(home.ctx, options),
		openSse,
		openGlobalEvents: (principal: MintedPrincipal) => openSse("/api/events", principal),
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
