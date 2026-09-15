import { Repository } from "./base.js";

export interface AuthSessionRow {
	id: string;
	user_id: string;
	username: string;
	created_at: string;
	expires_at: string;
	step_up_at: string | null;
	user_agent: string | null;
}

export class AuthSessionRepository extends Repository {
	create(input: {
		id: string;
		userId: string;
		username: string;
		ttlMs: number;
		userAgent?: string | null;
	}): AuthSessionRow {
		const now = this.clock.nowMs();
		this.db
			.prepare(
				`INSERT INTO auth_sessions (id, user_id, username, created_at, expires_at, step_up_at, user_agent)
				 VALUES (?, ?, ?, ?, ?, NULL, ?)`,
			)
			.run(
				input.id,
				input.userId,
				input.username,
				new Date(now).toISOString(),
				new Date(now + input.ttlMs).toISOString(),
				input.userAgent ?? null,
			);
		return this.get(input.id)!;
	}

	get(id: string): AuthSessionRow | undefined {
		return this.db.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id) as
			| AuthSessionRow
			| undefined;
	}

	/** Returns the row only when unexpired; expired rows are deleted lazily on access. */
	getLive(id: string): AuthSessionRow | undefined {
		const row = this.get(id);
		if (!row) return undefined;
		if (new Date(row.expires_at).getTime() <= this.clock.nowMs()) {
			this.delete(id);
			return undefined;
		}
		return row;
	}

	extend(id: string, ttlMs: number): void {
		this.db
			.prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?")
			.run(new Date(this.clock.nowMs() + ttlMs).toISOString(), id);
	}

	markStepUp(id: string): void {
		this.db
			.prepare("UPDATE auth_sessions SET step_up_at = ? WHERE id = ?")
			.run(this.clock.nowIso(), id);
	}

	delete(id: string): void {
		this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
	}

	deleteForUser(userId: string): void {
		this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
	}

	sweepExpired(): number {
		const info = this.db
			.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
			.run(this.clock.nowIso());
		return info.changes;
	}
}
