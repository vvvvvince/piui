// spec/16-extensions.md §2.1 — the extensions table and the per-profile opt-out list.
import { Repository } from "./base.js";

export interface ExtensionRow {
	id: string;
	name: string;
	path: string;
	source: string;
	origin: string | null;
	enabled: number;
	load_error: string | null;
	tools_json: string;
	commands_json: string;
	created_at: string;
	updated_at: string;
}

export interface UpsertExtensionInput {
	name: string;
	path: string;
	source: "managed" | "external";
	origin?: string | null;
}

export interface ProbeResultInput {
	tools: readonly string[];
	commands: readonly string[];
	loadError: string | null;
}

export class ExtensionRepository extends Repository {
	all(): ExtensionRow[] {
		return this.db
			.prepare("SELECT * FROM extensions ORDER BY source = 'managed' DESC, name")
			.all() as ExtensionRow[];
	}

	getById(id: string): ExtensionRow | undefined {
		return this.db.prepare("SELECT * FROM extensions WHERE id = ?").get(id) as
			| ExtensionRow
			| undefined;
	}

	findByName(name: string): ExtensionRow | undefined {
		return this.db.prepare("SELECT * FROM extensions WHERE name = ?").get(name) as
			| ExtensionRow
			| undefined;
	}

	findByPath(path: string): ExtensionRow | undefined {
		return this.db.prepare("SELECT * FROM extensions WHERE path = ?").get(path) as
			| ExtensionRow
			| undefined;
	}

	insert(input: UpsertExtensionInput): ExtensionRow {
		const now = this.clock.nowIso();
		const id = this.ids.newId();
		this.db
			.prepare(
				`INSERT INTO extensions (id, name, path, source, origin, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
			)
			.run(id, input.name, input.path, input.source, input.origin ?? null, now, now);
		return this.getById(id)!;
	}

	/** The probe's output (spec §4, step 3). Returns true when anything actually changed. */
	recordProbe(id: string, result: ProbeResultInput): boolean {
		const before = this.getById(id);
		const tools = JSON.stringify([...result.tools]);
		const commands = JSON.stringify([...result.commands]);
		if (
			before &&
			before.tools_json === tools &&
			before.commands_json === commands &&
			before.load_error === result.loadError
		) {
			return false;
		}
		this.db
			.prepare(
				"UPDATE extensions SET tools_json = ?, commands_json = ?, load_error = ?, updated_at = ? WHERE id = ?",
			)
			.run(tools, commands, result.loadError, this.clock.nowIso(), id);
		return true;
	}

	setEnabled(id: string, enabled: boolean): void {
		this.db
			.prepare("UPDATE extensions SET enabled = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, this.clock.nowIso(), id);
	}

	delete(id: string): void {
		this.db.prepare("DELETE FROM extensions WHERE id = ?").run(id);
	}

	// ------------------------------------------------ per-profile opt-out

	disabledIdsOfProfile(profileId: string): string[] {
		return (
			this.db
				.prepare(
					"SELECT extension_id FROM profile_disabled_extensions WHERE profile_id = ? ORDER BY extension_id",
				)
				.all(profileId) as { extension_id: string }[]
		).map((row) => row.extension_id);
	}

	setProfileDisabled(profileId: string, extensionIds: readonly string[]): void {
		const replace = this.db.transaction((ids: readonly string[]) => {
			this.db
				.prepare("DELETE FROM profile_disabled_extensions WHERE profile_id = ?")
				.run(profileId);
			const insert = this.db.prepare(
				"INSERT OR IGNORE INTO profile_disabled_extensions (profile_id, extension_id) VALUES (?, ?)",
			);
			for (const id of ids) insert.run(profileId, id);
		});
		replace(extensionIds);
	}

	/** Names of the profiles that switched this extension off (for the uninstall dialog). */
	profilesDisabling(extensionId: string): string[] {
		return (
			this.db
				.prepare(
					`SELECT p.name AS name FROM profile_disabled_extensions d
					 JOIN profiles p ON p.id = d.profile_id WHERE d.extension_id = ? ORDER BY p.name`,
				)
				.all(extensionId) as { name: string }[]
		).map((row) => row.name);
	}

	/** extension id -> number of profiles disabling it. */
	disabledCounts(): Map<string, number> {
		const rows = this.db
			.prepare(
				"SELECT extension_id, COUNT(*) AS n FROM profile_disabled_extensions GROUP BY extension_id",
			)
			.all() as { extension_id: string; n: number }[];
		return new Map(rows.map((row) => [row.extension_id, row.n]));
	}
}
