// The repository layer. spec/18-multi-user.md §4 — the two scoping predicates live HERE and
// nowhere else. No SQL against owned tables is allowed outside this directory.
import type { Principal } from "@piui/shared";
import type { Clock, IdGen } from "../../util/clock.js";
import type { Db } from "../index.js";

export type Visibility = "private" | "shared";

export interface OwnedRow {
	owner_id: string;
	visibility?: string;
}

/** Read scope: own ∪ shared. */
export function isVisible(
	principal: Principal,
	row: Pick<OwnedRow, "owner_id" | "visibility">,
): boolean {
	return row.owner_id === principal.id || row.visibility === "shared";
}

/** Write scope: own ∪ admin. */
export function isWritable(principal: Principal, row: Pick<OwnedRow, "owner_id">): boolean {
	return row.owner_id === principal.id || isAdmin(principal);
}

export function isAdmin(principal: Principal): boolean {
	return principal.roles.includes("admin");
}

/** SQL fragment + params implementing the read predicate for a table with a visibility column. */
export function visibleWhere(principal: Principal, alias = ""): { sql: string; params: string[] } {
	const p = alias ? `${alias}.` : "";
	return { sql: `(${p}owner_id = ? OR ${p}visibility = 'shared')`, params: [principal.id] };
}

/** Conversations are owned and always private — not even an admin sees another user's. */
export function ownWhere(principal: Principal, alias = ""): { sql: string; params: string[] } {
	const p = alias ? `${alias}.` : "";
	return { sql: `${p}owner_id = ?`, params: [principal.id] };
}

/** Thrown when the principal may not write a resource it can see. */
export class ForbiddenError extends Error {
	constructor(message = "forbidden") {
		super(message);
		this.name = "ForbiddenError";
	}
}

/** Thrown when the resource does not exist *or* is invisible — never distinguish the two. */
export class NotFoundError extends Error {
	constructor(message = "not found") {
		super(message);
		this.name = "NotFoundError";
	}
}

export abstract class Repository {
	constructor(
		protected readonly db: Db,
		protected readonly clock: Clock,
		protected readonly ids: IdGen,
	) {}
}

export interface RepoContext {
	db: Db;
	clock: Clock;
	ids: IdGen;
}
