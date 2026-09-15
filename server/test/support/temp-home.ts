// withTempHome — every test owns a fresh PIUI_HOME under os.tmpdir().
// spec/20-development-method.md §3.2.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config.js";
import { type AppContext, createContext, disposeContext } from "../../src/context.js";
import type { AuthProvider } from "../../src/http/auth.js";
import { FakeClock, SeqIdGen } from "../../src/util/clock.js";
import { silentLogger } from "./logger.js";
import { registerTempRoot } from "./temp-root-guard.js";

export interface TempHome {
	home: string;
	ctx: AppContext;
	clock: FakeClock;
	ids: SeqIdGen;
	/** Every artificial delay production code awaited, in ms — no test ever sleeps for real. */
	sleeps: number[];
	cleanup(): void;
}

export interface TempHomeOptions {
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	clock?: FakeClock;
	ids?: SeqIdGen;
	/** Swapping the auth provider must touch nothing but this wiring (spec/06-auth.md §8.6). */
	authProvider?: AuthProvider;
}

export function createTempHome(options: TempHomeOptions = {}): TempHome {
	const home = mkdtempSync(join(tmpdir(), "piui-test-"));
	registerTempRoot(home);
	const clock = options.clock ?? new FakeClock();
	const ids = options.ids ?? new SeqIdGen();
	const sleeps: number[] = [];

	const { config } = parseConfig({
		PIUI_HOME: home,
		PIUI_SESSION_SECRET: "test-secret",
		PIUI_PI_AUTH_PATH: join(home, "auth.json"),
		PIUI_SEARCH_PROVIDER: "none",
		NODE_ENV: "test",
		...options.env,
	});

	const ctx = createContext({
		config,
		clock,
		ids,
		logger: silentLogger(),
		...(options.authProvider ? { authProvider: options.authProvider } : {}),
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		fetch:
			options.fetch ??
			((() => {
				throw new Error("no test may perform real network I/O — inject a fetch");
			}) as unknown as typeof fetch),
		serveClient: false,
	});

	return {
		home,
		ctx,
		clock,
		ids,
		sleeps,
		cleanup() {
			disposeContext(ctx);
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** Scoped helper: `await withTempHome(async (t) => { ... })`. */
export async function withTempHome<T>(
	fn: (home: TempHome) => Promise<T> | T,
	options: TempHomeOptions = {},
): Promise<T> {
	const home = createTempHome(options);
	try {
		return await fn(home);
	} finally {
		home.cleanup();
	}
}
