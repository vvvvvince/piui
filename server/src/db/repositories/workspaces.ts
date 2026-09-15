import type { Principal } from "@piui/shared";
import {
	ForbiddenError,
	isVisible,
	isWritable,
	NotFoundError,
	Repository,
	visibleWhere,
} from "./base.js";

export interface WorkspaceRow {
	id: string;
	owner_id: string;
	visibility: string;
	name: string;
	path: string;
	description: string;
	trusted: number;
	trust_decided_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateWorkspaceInput {
	name: string;
	path: string;
	description?: string;
	visibility?: "private" | "shared";
}

export class WorkspaceRepository extends Repository {
	list(principal: Principal): WorkspaceRow[] {
		const where = visibleWhere(principal);
		return this.db
			.prepare(`SELECT * FROM workspaces WHERE ${where.sql} ORDER BY name`)
			.all(...where.params) as WorkspaceRow[];
	}

	get(principal: Principal, id: string): WorkspaceRow | undefined {
		const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
			| WorkspaceRow
			| undefined;
		if (!row || !isVisible(principal, row)) return undefined;
		return row;
	}

	findByPath(path: string): WorkspaceRow | undefined {
		return this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(path) as
			| WorkspaceRow
			| undefined;
	}

	getForWrite(principal: Principal, id: string): WorkspaceRow {
		const row = this.get(principal, id);
		if (!row) throw new NotFoundError(`workspace ${id} not found`);
		if (!isWritable(principal, row)) throw new ForbiddenError("you do not own this workspace");
		return row;
	}

	create(principal: Principal, input: CreateWorkspaceInput): WorkspaceRow {
		const now = this.clock.nowIso();
		const id = this.ids.newId();
		this.db
			.prepare(
				`INSERT INTO workspaces (id, owner_id, visibility, name, path, description, trusted,
					trust_decided_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
			)
			.run(
				id,
				principal.id,
				input.visibility ?? "private",
				input.name,
				input.path,
				input.description ?? "",
				now,
				now,
			);
		return this.get(principal, id)!;
	}

	update(
		principal: Principal,
		id: string,
		patch: Partial<CreateWorkspaceInput> & { trusted?: boolean },
	): WorkspaceRow {
		const row = this.getForWrite(principal, id);
		this.db
			.prepare(
				`UPDATE workspaces SET name = ?, description = ?, visibility = ?, trusted = ?,
					trust_decided_at = ?, updated_at = ? WHERE id = ?`,
			)
			.run(
				patch.name ?? row.name,
				patch.description ?? row.description,
				patch.visibility ?? row.visibility,
				patch.trusted === undefined ? row.trusted : patch.trusted ? 1 : 0,
				patch.trusted === undefined ? row.trust_decided_at : this.clock.nowIso(),
				this.clock.nowIso(),
				id,
			);
		return this.get(principal, id)!;
	}

	delete(principal: Principal, id: string): void {
		this.getForWrite(principal, id);
		this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
	}
}
