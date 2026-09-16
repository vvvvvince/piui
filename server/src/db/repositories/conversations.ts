import type { Principal, SessionMode, ThinkingLevel } from "@piui/shared";
import { NotFoundError, ownWhere, Repository } from "./base.js";

export interface ConversationRow {
	id: string;
	owner_id: string;
	title: string;
	mode: string;
	provider: string;
	model_id: string;
	thinking_level: string;
	profile_id: string | null;
	workspace_id: string | null;
	web_search: number;
	session_path: string | null;
	archived: number;
	last_message_at: string | null;
	tokens_total: number;
	cost_total: number;
	title_locked: number;
	timezone: string | null;
	/** spec/05-skills-and-tools.md §A.4 — a skill test run: never listed, swept after 1 h. */
	ephemeral: number;
	skill_id: string | null;
	ephemeral_tools: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateConversationInput {
	title?: string;
	mode: SessionMode;
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	profileId?: string | null;
	workspaceId?: string | null;
	webSearch?: boolean;
	timezone?: string | null;
	titleLocked?: boolean;
	/** A skill test run (spec/05-skills-and-tools.md §A.4). */
	ephemeral?: boolean;
	skillId?: string | null;
}

/**
 * Conversations are owned and ALWAYS private: an admin does not see another user's
 * transcripts (spec/18-multi-user.md §§3-4, acceptance 9.6).
 */
export class ConversationRepository extends Repository {
	list(
		principal: Principal,
		options: { archived?: boolean; limit?: number } = {},
	): ConversationRow[] {
		const where = ownWhere(principal);
		const archived = options.archived === undefined ? null : options.archived ? 1 : 0;
		const limit = Math.min(options.limit ?? 50, 200);
		// Ephemeral test runs are never listed (spec/05-skills-and-tools.md §A.4).
		if (archived === null) {
			return this.db
				.prepare(
					`SELECT * FROM conversations WHERE ${where.sql} AND ephemeral = 0
					 ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`,
				)
				.all(...where.params, limit) as ConversationRow[];
		}
		return this.db
			.prepare(
				`SELECT * FROM conversations WHERE ${where.sql} AND ephemeral = 0 AND archived = ?
				 ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`,
			)
			.all(...where.params, archived, limit) as ConversationRow[];
	}

	get(principal: Principal, id: string): ConversationRow | undefined {
		const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
			| ConversationRow
			| undefined;
		if (!row || row.owner_id !== principal.id) return undefined;
		return row;
	}

	/**
	 * Unscoped read for the background machinery (the session hub revives a conversation
	 * without a request principal). Route handlers MUST use `get`/`getOrThrow`.
	 */
	getById(id: string): ConversationRow | undefined {
		return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
			| ConversationRow
			| undefined;
	}

	getOrThrow(principal: Principal, id: string): ConversationRow {
		const row = this.get(principal, id);
		if (!row) throw new NotFoundError(`conversation ${id} not found`);
		return row;
	}

	create(principal: Principal, input: CreateConversationInput): ConversationRow {
		const now = this.clock.nowIso();
		const id = this.ids.newId();
		this.db
			.prepare(
				`INSERT INTO conversations (id, owner_id, title, mode, provider, model_id, thinking_level,
					profile_id, workspace_id, web_search, timezone, title_locked, ephemeral, skill_id,
					created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				principal.id,
				input.title ?? "",
				input.mode,
				input.provider,
				input.modelId,
				input.thinkingLevel ?? "off",
				input.profileId ?? null,
				input.workspaceId ?? null,
				input.webSearch ? 1 : 0,
				input.timezone ?? null,
				input.titleLocked || input.title ? 1 : 0,
				input.ephemeral ? 1 : 0,
				input.skillId ?? null,
				now,
				now,
			);
		return this.get(principal, id)!;
	}

	/** spec/04-workspaces.md §4 — "2 active conversations in this workspace". */
	countInWorkspace(principal: Principal, workspaceId: string): number {
		const where = ownWhere(principal);
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM conversations WHERE ${where.sql} AND workspace_id = ? AND archived = 0`,
			)
			.get(...where.params, workspaceId) as { n: number };
		return row.n;
	}

	/** A conversation "started" once it has a pi session file (spec/04-workspaces.md §4). */
	countStartedInWorkspace(workspaceId: string): number {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ? AND session_path IS NOT NULL",
			)
			.get(workspaceId) as { n: number };
		return row.n;
	}

	/** spec/09-api.md §4 — "usedByConversations" on the profile list. */
	countUsingProfile(principal: Principal, profileId: string): number {
		const where = ownWhere(principal);
		return (
			this.db
				.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE ${where.sql} AND profile_id = ?`)
				.get(...where.params, profileId) as { n: number }
		).n;
	}

	/** spec/03-profiles.md §7 — a deleted profile leaves its conversations readable. */
	detachProfile(profileId: string): number {
		return this.db
			.prepare("UPDATE conversations SET profile_id = NULL, updated_at = ? WHERE profile_id = ?")
			.run(this.clock.nowIso(), profileId).changes;
	}

	/** Deleting a workspace keeps every transcript: `workspace_id` just becomes NULL (§6). */
	/** Unscoped: a trust change must invalidate every session in the folder, whoever owns it. */
	idsInWorkspace(workspaceId: string): string[] {
		return (
			this.db.prepare("SELECT id FROM conversations WHERE workspace_id = ?").all(workspaceId) as {
				id: string;
			}[]
		).map((row) => row.id);
	}

	detachWorkspace(workspaceId: string): number {
		return this.db
			.prepare(
				"UPDATE conversations SET workspace_id = NULL, updated_at = ? WHERE workspace_id = ?",
			)
			.run(this.clock.nowIso(), workspaceId).changes;
	}

	/** Only reachable before a session exists (spec/09-api.md §8, `immutable_after_start`). */
	setProfileAndWorkspace(
		principal: Principal,
		id: string,
		patch: { profileId?: string; workspaceId?: string },
	): void {
		const row = this.getOrThrow(principal, id);
		this.db
			.prepare(
				"UPDATE conversations SET profile_id = ?, workspace_id = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				patch.profileId ?? row.profile_id,
				patch.workspaceId ?? row.workspace_id,
				this.clock.nowIso(),
				id,
			);
	}

	setSessionPath(principal: Principal, id: string, sessionPath: string): void {
		this.getOrThrow(principal, id);
		this.db
			.prepare("UPDATE conversations SET session_path = ?, updated_at = ? WHERE id = ?")
			.run(sessionPath, this.clock.nowIso(), id);
	}

	recordUsage(
		principal: Principal,
		id: string,
		usage: { tokensTotal: number; costTotal: number; lastMessageAt?: string },
	): void {
		this.getOrThrow(principal, id);
		this.db
			.prepare(
				`UPDATE conversations SET tokens_total = ?, cost_total = ?, last_message_at = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				usage.tokensTotal,
				usage.costTotal,
				usage.lastMessageAt ?? this.clock.nowIso(),
				this.clock.nowIso(),
				id,
			);
	}

	setTitle(principal: Principal, id: string, title: string, locked = true): void {
		this.getOrThrow(principal, id);
		this.db
			.prepare("UPDATE conversations SET title = ?, title_locked = ?, updated_at = ? WHERE id = ?")
			.run(title, locked ? 1 : 0, this.clock.nowIso(), id);
	}

	/** Auto-title (decision Q8): never overwrites a title the user chose. */
	setAutoTitle(id: string, title: string): boolean {
		const result = this.db
			.prepare(
				"UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND title_locked = 0",
			)
			.run(title, this.clock.nowIso(), id);
		return result.changes > 0;
	}

	setModel(
		principal: Principal,
		id: string,
		model: { provider: string; modelId: string; thinkingLevel?: string; webSearch?: boolean },
	): void {
		const row = this.getOrThrow(principal, id);
		this.db
			.prepare(
				`UPDATE conversations SET provider = ?, model_id = ?, thinking_level = ?, web_search = ?,
				 updated_at = ? WHERE id = ?`,
			)
			.run(
				model.provider,
				model.modelId,
				model.thinkingLevel ?? row.thinking_level,
				model.webSearch === undefined ? row.web_search : model.webSearch ? 1 : 0,
				this.clock.nowIso(),
				id,
			);
	}

	/** Usage written from `session.getSessionStats()` at run end, without a principal. */
	recordUsageById(id: string, usage: { tokensTotal: number; costTotal: number }): void {
		this.db
			.prepare(
				`UPDATE conversations SET tokens_total = ?, cost_total = ?, last_message_at = ?,
				 updated_at = ? WHERE id = ?`,
			)
			.run(usage.tokensTotal, usage.costTotal, this.clock.nowIso(), this.clock.nowIso(), id);
	}

	setSessionPathById(id: string, sessionPath: string): void {
		this.db
			.prepare("UPDATE conversations SET session_path = ?, updated_at = ? WHERE id = ?")
			.run(sessionPath, this.clock.nowIso(), id);
	}

	/** spec/05-skills-and-tools.md §A.4 — the tool allowlist a revived test run rebuilds with. */
	setEphemeralTools(id: string, tools: readonly string[]): void {
		this.db
			.prepare("UPDATE conversations SET ephemeral_tools = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(tools), this.clock.nowIso(), id);
	}

	setArchived(principal: Principal, id: string, archived: boolean): void {
		this.getOrThrow(principal, id);
		this.db
			.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?")
			.run(archived ? 1 : 0, this.clock.nowIso(), id);
	}

	delete(principal: Principal, id: string): void {
		this.getOrThrow(principal, id);
		this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
	}

	deleteById(id: string): void {
		this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
	}

	/** spec/05-skills-and-tools.md §A.4 — test runs older than the cutoff, for the sweep. */
	expiredEphemeral(cutoffIso: string): ConversationRow[] {
		return this.db
			.prepare("SELECT * FROM conversations WHERE ephemeral = 1 AND created_at < ?")
			.all(cutoffIso) as ConversationRow[];
	}
}
