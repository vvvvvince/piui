// Principal minting — spec/20-development-method.md §3.4, spec/18-multi-user.md §9.3-9.6.
// Inserts a user + auth_sessions row directly and returns the cookie a request would carry.
import { createHmac, randomBytes } from "node:crypto";
import type { Principal } from "@piui/shared";
import type { AppContext } from "../../src/context.js";

export interface MintedPrincipal {
	principal: Principal;
	sessionId: string;
	cookie: string;
	headers: Record<string, string>;
}

export interface MintOptions {
	id?: string;
	username?: string;
	displayName?: string;
	role?: "admin" | "user";
	active?: boolean;
	ttlMs?: number;
}

export const SESSION_COOKIE = "piui_sid";
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function signSessionId(sessionId: string, secret: string): string {
	const mac = createHmac("sha256", secret).update(sessionId).digest("hex");
	return `${sessionId}.${mac}`;
}

/** Creates the user if needed, opens a session, returns ready-to-use request headers. */
export function mintPrincipal(ctx: AppContext, options: MintOptions = {}): MintedPrincipal {
	const id = options.id ?? "local";
	const username = options.username ?? (id === "local" ? ctx.config.username : id);
	const role = options.role ?? (id === "local" ? "admin" : "user");
	const now = ctx.clock.nowIso();

	const existing = ctx.repos.users.get(id);
	if (!existing) {
		ctx.db
			.prepare(
				`INSERT INTO users (id, username, display_name, role, active, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				username,
				options.displayName ?? username,
				role,
				options.active === false ? 0 : 1,
				now,
				now,
			);
	} else if (options.role || options.active !== undefined) {
		ctx.db
			.prepare("UPDATE users SET role = ?, active = ?, updated_at = ? WHERE id = ?")
			.run(role, options.active === false ? 0 : 1, now, id);
	}

	const sessionId = randomBytes(32).toString("hex");
	ctx.repos.authSessions.create({
		id: sessionId,
		userId: id,
		username,
		ttlMs: options.ttlMs ?? THIRTY_DAYS,
	});

	const cookieValue = signSessionId(sessionId, ctx.config.sessionSecret);
	const cookie = `${SESSION_COOKIE}=${cookieValue}`;
	const row = ctx.repos.users.get(id)!;

	return {
		principal: ctx.repos.users.toPrincipal(row),
		sessionId,
		cookie,
		headers: { cookie, "x-requested-with": "piui" },
	};
}

/** A principal object without any DB session — for direct repository-layer tests. */
export function principalOf(id: string, role: "admin" | "user" = "user"): Principal {
	return { id, username: id, displayName: id, roles: [role] };
}
