import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../support/temp-home.js";

const EXPECTED_TABLES = [
	"auth_sessions",
	"conversations",
	"extensions",
	"http_tools",
	"profile_disabled_extensions",
	"profile_skills",
	"profile_tools",
	"profiles",
	"schema_migrations",
	"skills",
	"tool_settings",
	"users",
	"workspaces",
];

const OWNED_TABLES = ["profiles", "workspaces", "skills", "http_tools"];

describe("database bootstrap", () => {
	it("[12-milestones#M0.3] creates the db file with every table", async () => {
		await withTempHome(({ ctx }) => {
			expect(existsSync(ctx.config.dbPath)).toBe(true);
			const tables = ctx.db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all()
				.map((r) => (r as { name: string }).name)
				.filter((n) => !n.startsWith("sqlite_"));
			expect(tables).toEqual(EXPECTED_TABLES);
		});
	});

	it("enables WAL and foreign keys", async () => {
		await withTempHome(({ ctx }) => {
			expect(String(ctx.db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
			expect(ctx.db.pragma("foreign_keys", { simple: true })).toBe(1);
		});
	});

	it("records applied migrations and is idempotent across reopens", async () => {
		await withTempHome(({ ctx }) => {
			const versions = ctx.db
				.prepare("SELECT version FROM schema_migrations ORDER BY version")
				.all()
				.map((r) => (r as { version: number }).version);
			expect(versions).toEqual([1, 2, 3]);
		});
	});

	it("[18-multi-user#9.1] seeds exactly one active admin", async () => {
		await withTempHome(({ ctx }) => {
			const users = ctx.repos.users.list();
			expect(users).toHaveLength(1);
			expect(users[0]).toMatchObject({ id: "local", role: "admin", active: 1 });
		});
	});

	it("[18-multi-user#9.1] gives every owned table owner_id NOT NULL and visibility default private", async () => {
		await withTempHome(({ ctx }) => {
			for (const table of OWNED_TABLES) {
				const columns = ctx.db.prepare(`PRAGMA table_info(${table})`).all() as {
					name: string;
					notnull: number;
					dflt_value: string | null;
				}[];
				const owner = columns.find((c) => c.name === "owner_id");
				const visibility = columns.find((c) => c.name === "visibility");
				expect(owner, `${table}.owner_id`).toBeDefined();
				expect(owner?.notnull, `${table}.owner_id NOT NULL`).toBe(1);
				expect(visibility?.notnull, `${table}.visibility NOT NULL`).toBe(1);
				expect(visibility?.dflt_value).toBe("'private'");
			}
			// Conversations are owned but always private: no visibility column by design.
			const conversationColumns = ctx.db
				.prepare("PRAGMA table_info(conversations)")
				.all()
				.map((c) => (c as { name: string }).name);
			expect(conversationColumns).toContain("owner_id");
			expect(conversationColumns).not.toContain("visibility");
		});
	});

	it("uses the configured username for the seeded admin", async () => {
		await withTempHome(
			({ ctx }) => {
				expect(ctx.repos.users.get("local")?.username).toBe("alice");
			},
			{ env: { PIUI_USERNAME: "alice", PIUI_PASSWORD: "hunter2" } },
		);
	});
});
