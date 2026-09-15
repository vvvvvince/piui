// SQLite open + migration runner. spec/01-architecture.md §1, spec/02-data-model.md §2.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Clock } from "../util/clock.js";

export type Db = Database.Database;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface OpenDbOptions {
	path: string;
	clock: Clock;
	/** Seeded admin user (spec/18-multi-user.md §8). */
	seedUser: { id: string; username: string; displayName?: string };
	migrationsDir?: string;
}

export function openDb(options: OpenDbOptions): Db {
	mkdirSync(dirname(options.path), { recursive: true });
	const db = new Database(options.path);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	migrate(db, options.migrationsDir ?? migrationsDir, options.clock);
	seed(db, options);
	return db;
}

export function migrate(db: Db, dir: string, clock: Clock): number[] {
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
	);
	const applied = new Set(
		db
			.prepare("SELECT version FROM schema_migrations")
			.all()
			.map((r) => (r as { version: number }).version),
	);
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const ran: number[] = [];
	for (const file of files) {
		const version = Number(file.slice(0, file.indexOf("_")));
		if (!Number.isInteger(version))
			throw new Error(`migration filename must start with NNN_: ${file}`);
		if (applied.has(version)) continue;
		const sql = readFileSync(join(dir, file), "utf8");
		const run = db.transaction(() => {
			db.exec(sql);
			db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
				version,
				clock.nowIso(),
			);
		});
		run();
		ran.push(version);
	}
	return ran;
}

function seed(db: Db, options: OpenDbOptions): void {
	const now = options.clock.nowIso();
	const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(options.seedUser.id);
	if (existing) {
		db.prepare("UPDATE users SET username = ?, updated_at = ? WHERE id = ? AND username <> ?").run(
			options.seedUser.username,
			now,
			options.seedUser.id,
			options.seedUser.username,
		);
		return;
	}
	db.prepare(
		`INSERT INTO users (id, username, display_name, role, active, created_at, updated_at)
		 VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
	).run(
		options.seedUser.id,
		options.seedUser.username,
		options.seedUser.displayName ?? "Local user",
		now,
		now,
	);
}

export function closeDb(db: Db): void {
	db.close();
}
