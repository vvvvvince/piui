// All SQL against `http_tools` (spec/01-architecture.md §2.2). spec/05-skills-and-tools.md §B.2.
import type { Principal } from "@piui/shared";
import { isVisible, Repository, visibleWhere } from "./base.js";

export interface HttpToolRow {
	id: string;
	owner_id: string;
	visibility: string;
	name: string;
	label: string;
	description: string;
	enabled: number;
	method: string;
	url_template: string;
	/** JSON object; values may contain `${ENV_VAR}` and NEVER leave the server (§B.2). */
	headers_json: string;
	body_template: string | null;
	params_json: string;
	timeout_ms: number;
	created_at: string;
	updated_at: string;
}

export interface UpsertHttpToolInput {
	name: string;
	label: string;
	description: string;
	method: string;
	urlTemplate: string;
	headers: Record<string, string>;
	bodyTemplate: string | null;
	parameters: unknown;
	timeoutMs: number;
	enabled?: boolean;
}

export class HttpToolRepository extends Repository {
	list(principal: Principal): HttpToolRow[] {
		const where = visibleWhere(principal);
		return this.db
			.prepare(`SELECT * FROM http_tools WHERE ${where.sql} ORDER BY name`)
			.all(...where.params) as HttpToolRow[];
	}

	/** Unscoped: session construction runs without a request principal. */
	all(): HttpToolRow[] {
		return this.db.prepare("SELECT * FROM http_tools ORDER BY name").all() as HttpToolRow[];
	}

	get(principal: Principal, id: string): HttpToolRow | undefined {
		const row = this.db.prepare("SELECT * FROM http_tools WHERE id = ?").get(id) as
			| HttpToolRow
			| undefined;
		return row && isVisible(principal, row) ? row : undefined;
	}

	findByName(name: string): HttpToolRow | undefined {
		return this.db.prepare("SELECT * FROM http_tools WHERE name = ?").get(name) as
			| HttpToolRow
			| undefined;
	}

	insert(ownerId: string, input: UpsertHttpToolInput): HttpToolRow {
		const now = this.clock.nowIso();
		const id = this.ids.newId();
		this.db
			.prepare(
				`INSERT INTO http_tools (id, owner_id, visibility, name, label, description, enabled,
					method, url_template, headers_json, body_template, params_json, timeout_ms,
					created_at, updated_at)
				 VALUES (?, ?, 'shared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				ownerId,
				input.name,
				input.label,
				input.description,
				input.enabled === false ? 0 : 1,
				input.method,
				input.urlTemplate,
				JSON.stringify(input.headers),
				input.bodyTemplate,
				JSON.stringify(input.parameters),
				input.timeoutMs,
				now,
				now,
			);
		return this.db.prepare("SELECT * FROM http_tools WHERE id = ?").get(id) as HttpToolRow;
	}

	update(id: string, input: UpsertHttpToolInput): HttpToolRow {
		this.db
			.prepare(
				`UPDATE http_tools SET name = ?, label = ?, description = ?, enabled = ?, method = ?,
					url_template = ?, headers_json = ?, body_template = ?, params_json = ?, timeout_ms = ?,
					updated_at = ? WHERE id = ?`,
			)
			.run(
				input.name,
				input.label,
				input.description,
				input.enabled === false ? 0 : 1,
				input.method,
				input.urlTemplate,
				JSON.stringify(input.headers),
				input.bodyTemplate,
				JSON.stringify(input.parameters),
				input.timeoutMs,
				this.clock.nowIso(),
				id,
			);
		return this.db.prepare("SELECT * FROM http_tools WHERE id = ?").get(id) as HttpToolRow;
	}

	delete(id: string): void {
		this.db.prepare("DELETE FROM http_tools WHERE id = ?").run(id);
	}

	/** Profiles that selected this tool by name — the delete dialog lists them (§B.2). */
	profilesUsing(name: string): string[] {
		return (
			this.db
				.prepare(
					`SELECT p.name AS name FROM profile_tools pt
					 JOIN profiles p ON p.id = pt.profile_id
					 WHERE pt.tool_name = ? ORDER BY p.name`,
				)
				.all(name) as { name: string }[]
		).map((row) => row.name);
	}

	/** A renamed or deleted tool must not linger in a profile's selection. */
	forgetToolName(name: string): void {
		this.db.prepare("DELETE FROM profile_tools WHERE tool_name = ?").run(name);
	}
}
