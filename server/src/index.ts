// Boot: config -> context -> fastify -> graceful shutdown.
import { ConfigError, parseConfig } from "./config.js";
import { createContext, disposeContext } from "./context.js";
import { buildServer } from "./http/server.js";

async function main(): Promise<void> {
	let parsed: ReturnType<typeof parseConfig>;
	try {
		parsed = parseConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(`piui: ${error.message}`);
			process.exit(2);
		}
		throw error;
	}

	const ctx = createContext({ config: parsed.config });
	for (const warning of parsed.warnings) {
		ctx.logger[warning.level](warning.message);
	}

	const app = await buildServer(ctx);
	await app.listen({ port: ctx.config.port, host: ctx.config.host });
	ctx.logger.info(
		{ home: ctx.config.home, pi: ctx.piVersion },
		`piui ${ctx.version} listening on http://${ctx.config.host}:${ctx.config.port}`,
	);

	// Expired sessions are deleted lazily on access plus by this sweep (spec/06-auth.md §2).
	const sweep = setInterval(
		() => {
			const removed = ctx.repos.authSessions.sweepExpired();
			if (removed > 0) ctx.logger.debug({ removed }, "expired sessions swept");
		},
		60 * 60 * 1000,
	);
	sweep.unref();

	// Idle live sessions are dropped after 15 minutes (spec/01-architecture.md §4.5).
	const evict = setInterval(() => {
		const evicted = app.piui.hub.evictIdle();
		if (evicted.length > 0) ctx.logger.debug({ evicted }, "idle sessions evicted");
	}, 60 * 1000);
	evict.unref();

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		ctx.logger.info({ signal }, "shutting down");
		clearInterval(sweep);
		clearInterval(evict);
		try {
			// `app.close()` runs the onClose hook: abort streaming runs, dispose live sessions.
			await app.close();
			disposeContext(ctx);
			process.exit(0);
		} catch (error) {
			ctx.logger.error({ err: error }, "error during shutdown");
			process.exit(1);
		}
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
