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
		if (archived === null) {
			return this.db
				.prepare(
					`SELECT * FROM conversations WHERE ${where.sql}
					 ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`,
				)
				.all(...where.params, limit) as ConversationRow[];
		}
		return this.db
			.prepare(
				`SELECT * FROM conversations WHERE ${where.sql} AND archived = ?
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
					profile_id, workspace_id, web_search, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				now,
				now,
			);
		return this.get(principal, id)!;
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

	setTitle(principal: Principal, id: string, title: string): void {
		this.getOrThrow(principal, id);
		this.db
			.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
			.run(title, this.clock.nowIso(), id);
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
}
