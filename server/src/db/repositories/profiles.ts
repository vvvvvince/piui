import type { Principal } from "@piui/shared";
import {
	ForbiddenError,
	isVisible,
	isWritable,
	NotFoundError,
	Repository,
	visibleWhere,
} from "./base.js";

export interface ProfileRow {
	id: string;
	owner_id: string;
	visibility: string;
	name: string;
	description: string;
	memory_enabled: number;
	memory_path: string | null;
	include_discovered_skills: number;
	allow_dynamic_extension_tools: number;
	default_model: string | null;
	default_thinking: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateProfileInput {
	name: string;
	description?: string;
	visibility?: "private" | "shared";
	memoryEnabled?: boolean;
	memoryPath?: string | null;
	includeDiscoveredSkills?: boolean;
	allowDynamicExtensionTools?: boolean;
	defaultModel?: string | null;
	defaultThinking?: string | null;
}

export class ProfileRepository extends Repository {
	list(principal: Principal): ProfileRow[] {
		const where = visibleWhere(principal);
		return this.db
			.prepare(`SELECT * FROM profiles WHERE ${where.sql} ORDER BY name`)
			.all(...where.params) as ProfileRow[];
	}

	/** Returns undefined when the row does not exist or is invisible (caller maps to 404). */
	get(principal: Principal, id: string): ProfileRow | undefined {
		const row = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as
			| ProfileRow
			| undefined;
		if (!row || !isVisible(principal, row)) return undefined;
		return row;
	}

	getForWrite(principal: Principal, id: string): ProfileRow {
		const row = this.get(principal, id);
		if (!row) throw new NotFoundError(`profile ${id} not found`);
		if (!isWritable(principal, row)) throw new ForbiddenError("you do not own this profile");
		return row;
	}

	create(principal: Principal, input: CreateProfileInput): ProfileRow {
		const now = this.clock.nowIso();
		const id = this.ids.newId();
		this.db
			.prepare(
				`INSERT INTO profiles (id, owner_id, visibility, name, description, memory_enabled, memory_path,
					include_discovered_skills, allow_dynamic_extension_tools, default_model, default_thinking,
					created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				principal.id,
				input.visibility ?? "private",
				input.name,
				input.description ?? "",
				input.memoryEnabled ? 1 : 0,
				input.memoryPath ?? null,
				input.includeDiscoveredSkills ? 1 : 0,
				input.allowDynamicExtensionTools === false ? 0 : 1,
				input.defaultModel ?? null,
				input.defaultThinking ?? null,
				now,
				now,
			);
		return this.get(principal, id)!;
	}

	update(principal: Principal, id: string, patch: Partial<CreateProfileInput>): ProfileRow {
		const row = this.getForWrite(principal, id);
		const next = {
			name: patch.name ?? row.name,
			description: patch.description ?? row.description,
			visibility: patch.visibility ?? row.visibility,
			memory_enabled:
				patch.memoryEnabled === undefined ? row.memory_enabled : patch.memoryEnabled ? 1 : 0,
			memory_path: patch.memoryPath === undefined ? row.memory_path : patch.memoryPath,
			include_discovered_skills:
				patch.includeDiscoveredSkills === undefined
					? row.include_discovered_skills
					: patch.includeDiscoveredSkills
						? 1
						: 0,
			allow_dynamic_extension_tools:
				patch.allowDynamicExtensionTools === undefined
					? row.allow_dynamic_extension_tools
					: patch.allowDynamicExtensionTools
						? 1
						: 0,
			default_model: patch.defaultModel === undefined ? row.default_model : patch.defaultModel,
			default_thinking:
				patch.defaultThinking === undefined ? row.default_thinking : patch.defaultThinking,
		};
		this.db
			.prepare(
				`UPDATE profiles SET name = ?, description = ?, visibility = ?, memory_enabled = ?, memory_path = ?,
					include_discovered_skills = ?, allow_dynamic_extension_tools = ?, default_model = ?,
					default_thinking = ?, updated_at = ? WHERE id = ?`,
			)
			.run(
				next.name,
				next.description,
				next.visibility,
				next.memory_enabled,
				next.memory_path,
				next.include_discovered_skills,
				next.allow_dynamic_extension_tools,
				next.default_model,
				next.default_thinking,
				this.clock.nowIso(),
				id,
			);
		return this.get(principal, id)!;
	}

	delete(principal: Principal, id: string): void {
		this.getForWrite(principal, id);
		this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
	}

	/** The profile's selected tool names (spec/03-profiles.md §4); read by the tool catalog. */
	toolNames(principal: Principal, id: string): string[] {
		this.getForWrite(principal, id);
		return (
			this.db
				.prepare("SELECT tool_name FROM profile_tools WHERE profile_id = ? ORDER BY tool_name")
				.all(id) as { tool_name: string }[]
		).map((row) => row.tool_name);
	}

	setTools(principal: Principal, id: string, names: readonly string[]): void {
		this.getForWrite(principal, id);
		const replace = this.db.transaction((toolNames: readonly string[]) => {
			this.db.prepare("DELETE FROM profile_tools WHERE profile_id = ?").run(id);
			const insert = this.db.prepare(
				"INSERT OR IGNORE INTO profile_tools (profile_id, tool_name) VALUES (?, ?)",
			);
			for (const name of toolNames) insert.run(id, name);
		});
		replace(names);
	}
}
