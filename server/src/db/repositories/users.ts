import type { Principal } from "@piui/shared";
import { Repository } from "./base.js";

export interface UserRow {
	id: string;
	username: string;
	display_name: string;
	role: string;
	active: number;
	created_at: string;
	updated_at: string;
}

export class UserRepository extends Repository {
	get(id: string): UserRow | undefined {
		return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
	}

	findByUsername(username: string): UserRow | undefined {
		return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
			| UserRow
			| undefined;
	}

	/** Owner of machine-created rows (the filesystem skill mirror). The seeded admin. */
	adminId(): string {
		const row = this.db
			.prepare(
				"SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at LIMIT 1",
			)
			.get() as { id: string } | undefined;
		return row?.id ?? "local";
	}

	list(): UserRow[] {
		return this.db.prepare("SELECT * FROM users ORDER BY username").all() as UserRow[];
	}

	toPrincipal(row: UserRow): Principal {
		return {
			id: row.id,
			username: row.username,
			displayName: row.display_name,
			roles: [row.role],
		};
	}
}
