// The application context: everything injectable lives here, nothing reaches for a global.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, pino } from "pino";
import type { Config } from "./config.js";
import { type Db, openDb } from "./db/index.js";
import { createRepositories, type Repositories } from "./db/repositories/index.js";
import { type Clock, type IdGen, systemClock, systemIdGen } from "./util/clock.js";

export type FetchLike = typeof fetch;

export interface AppContext {
	config: Config;
	db: Db;
	repos: Repositories;
	clock: Clock;
	ids: IdGen;
	logger: Logger;
	fetch: FetchLike;
	version: string;
	piVersion: string;
	serveClient: boolean;
}

export interface CreateContextOptions {
	config: Config;
	clock?: Clock;
	ids?: IdGen;
	logger?: Logger;
	fetch?: FetchLike;
	serveClient?: boolean;
}

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readVersion(path: string, fallback: string): string {
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? fallback;
	} catch {
		return fallback;
	}
}

export function createContext(options: CreateContextOptions): AppContext {
	const { config } = options;
	const clock = options.clock ?? systemClock;
	const ids = options.ids ?? systemIdGen;

	ensureHomeLayout(config);

	const logger =
		options.logger ??
		pino(
			config.nodeEnv === "production"
				? { level: config.logLevel }
				: {
						level: config.logLevel,
						transport: { target: "pino-pretty", options: { colorize: true } },
					},
		);

	const db = openDb({
		path: config.dbPath,
		clock,
		seedUser: { id: "local", username: config.username, displayName: "Local user" },
	});

	return {
		config,
		db,
		repos: createRepositories(db, clock, ids),
		clock,
		ids,
		logger,
		fetch: options.fetch ?? globalThis.fetch,
		version: readVersion(join(pkgDir, "package.json"), "0.0.0"),
		piVersion: readVersion(
			join(pkgDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
			readVersion(
				join(pkgDir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
				"unknown",
			),
		),
		serveClient: options.serveClient ?? config.nodeEnv === "production",
	};
}

export function ensureHomeLayout(config: Config): void {
	for (const dir of [
		config.home,
		config.agentDir,
		config.sessionsDir,
		config.paths.profiles,
		config.paths.skills,
		config.paths.extensions,
		config.paths.prompts,
		config.paths.uploads,
		config.paths.scratch,
		config.paths.logs,
	]) {
		mkdirSync(dir, { recursive: true });
	}
}

export function disposeContext(ctx: AppContext): void {
	ctx.db.close();
}
