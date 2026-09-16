import type { Principal } from "@piui/shared";
import { isVisible, Repository, visibleWhere } from "./base.js";

export interface SkillRow {
	id: string;
	owner_id: string;
	visibility: string;
	dir_name: string;
	name: string;
	description: string;
	enabled: number;
	source: string;
	ext_path: string | null;
	created_at: string;
	updated_at: string;
}

export interface UpsertSkillInput {
	dirName: string;
	name: string;
	description: string;
	source?: "managed" | "external";
	extPath?: string | null;
	ownerId: string;
}

export class SkillRepository extends Repository {
	list(principal: Principal): SkillRow[] {
		const where = visibleWhere(principal);
		return this.db
			.prepare(`SELECT * FROM skills WHERE ${where.sql} ORDER BY name`)
			.all(...where.params) as SkillRow[];
	}

	/** Unscoped: the filesystem scan and the resolution pipeline run without a principal. */
	all(): SkillRow[] {
		return this.db.prepare("SELECT * FROM skills ORDER BY name").all() as SkillRow[];
	}

	get(principal: Principal, id: string): SkillRow | undefined {
		const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as
			| SkillRow
			| undefined;
		if (!row || !isVisible(principal, row)) return undefined;
		return row;
	}

	getById(id: string): SkillRow | undefined {
		return this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
	}

	/** Filesystem is the source of truth: insert on first sight, update name/description after. */
	upsert(input: UpsertSkillInput): SkillRow {
		const now = this.clock.nowIso();
		const existing = this.db
			.prepare("SELECT * FROM skills WHERE dir_name = ?")
			.get(input.dirName) as SkillRow | undefined;
		if (existing) {
			this.db
				.prepare(
					"UPDATE skills SET name = ?, description = ?, enabled = 1, ext_path = ?, updated_at = ? WHERE id = ?",
				)
				.run(input.name, input.description, input.extPath ?? null, now, existing.id);
			return this.getById(existing.id)!;
		}
		const id = this.ids.newId();
		this.db
			.prepare(
				`INSERT INTO skills (id, owner_id, visibility, dir_name, name, description, enabled, source,
					ext_path, created_at, updated_at)
				 VALUES (?, ?, 'shared', ?, ?, ?, 1, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.ownerId,
				input.dirName,
				input.name,
				input.description,
				input.source ?? "managed",
				input.extPath ?? null,
				now,
				now,
			);
		return this.getById(id)!;
	}

	/** A directory that vanished keeps its row (a profile may reference it) but is disabled. */
	markMissing(ids: readonly string[]): void {
		const disable = this.db.prepare(
			"UPDATE skills SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1",
		);
		for (const id of ids) disable.run(this.clock.nowIso(), id);
	}

	setEnabled(id: string, enabled: boolean): void {
		this.db
			.prepare("UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, this.clock.nowIso(), id);
	}

	/** spec/05-skills-and-tools.md §A.5 — the names the delete dialog must list. */
	profilesUsing(skillId: string): string[] {
		return (
			this.db
				.prepare(
					`SELECT p.name AS name FROM profile_skills ps
					 JOIN profiles p ON p.id = ps.profile_id
					 WHERE ps.skill_id = ? ORDER BY p.name`,
				)
				.all(skillId) as { name: string }[]
		).map((row) => row.name);
	}

	/** skill id -> number of profiles that selected it. */
	profileUsage(): Map<string, number> {
		const rows = this.db
			.prepare("SELECT skill_id, COUNT(*) AS n FROM profile_skills GROUP BY skill_id")
			.all() as { skill_id: string; n: number }[];
		return new Map(rows.map((row) => [row.skill_id, row.n]));
	}

	skillIdsOfProfile(profileId: string): string[] {
		return (
			this.db
				.prepare("SELECT skill_id FROM profile_skills WHERE profile_id = ? ORDER BY skill_id")
				.all(profileId) as { skill_id: string }[]
		).map((row) => row.skill_id);
	}

	setProfileSkills(profileId: string, skillIds: readonly string[]): void {
		const replace = this.db.transaction((ids: readonly string[]) => {
			this.db.prepare("DELETE FROM profile_skills WHERE profile_id = ?").run(profileId);
			const insert = this.db.prepare(
				"INSERT OR IGNORE INTO profile_skills (profile_id, skill_id) VALUES (?, ?)",
			);
			for (const id of ids) insert.run(profileId, id);
		});
		replace(skillIds);
	}

	/** M5 keeps the link rows when a skill row is deleted only if the FK allows it; it does not. */
	delete(id: string): void {
		this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
	}
}
