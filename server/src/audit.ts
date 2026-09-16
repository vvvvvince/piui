// spec/11-security.md §7 — the append-only audit log, one JSON line per mutation.
//
// Storage is a file, not a table (M7 decision): it must survive `docker compose down -v`-style
// container replacement inside `/data/logs/`, it is written far more often than it is read, and
// an append-only file cannot be silently edited by the same code that writes rows.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./util/redact.js";

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEntry {
	actor: string;
	action: string;
	target?: string | null;
	outcome: AuditOutcome;
	[extra: string]: unknown;
}

export class AuditLog {
	constructor(
		private readonly path: string,
		private readonly nowIso: () => string,
	) {}

	record(entry: AuditEntry): void {
		const line = { ts: this.nowIso(), target: null, ...entry };
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(this.path, `${JSON.stringify(redactDeep(line))}\n`, { mode: 0o600 });
		} catch {
			// An unwritable audit log must never take a request down with it; the request log
			// already carries the same line's essentials.
		}
	}
}

function redactDeep(value: unknown): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map(redactDeep);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, inner]) =>
				SECRET_KEYS.has(key.toLowerCase()) ? [key, "***"] : [key, redactDeep(inner)],
			),
		);
	}
	return value;
}

/** spec/11-security.md §3 — never logged, whatever the value looks like. */
const SECRET_KEYS = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"password",
	"apikey",
	"api_key",
	"secret",
	"token",
	"headers",
]);

const SINGULAR: Record<string, string> = {
	profiles: "profile",
	workspaces: "workspace",
	skills: "skill",
	tools: "tool",
	conversations: "conversation",
	extensions: "extension",
	providers: "provider",
	uploads: "upload",
	prompts: "prompt",
	users: "user",
	settings: "settings",
	auth: "auth",
};

/**
 * Turns a mutating request into `{ action, target }`. One rule instead of a decorator per route,
 * so a route added later is audited by construction rather than by remembering.
 */
export function auditAction(
	method: string,
	url: string,
): { action: string; target: string | null } | null {
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
	const path = url.split("?")[0]!;
	if (!path.startsWith("/api/")) return null;
	const segments = path.slice("/api/".length).split("/").filter(Boolean);
	const head = segments[0];
	if (!head) return null;
	const resource = SINGULAR[head] ?? head.replace(/s$/, "");

	if (segments.length === 1) {
		return { action: `${resource}.${method === "POST" ? "create" : "update"}`, target: null };
	}
	if (segments.length === 2) {
		// POST /api/auth/login, /api/skills/rescan, /api/skills/import-zip — named operations.
		if (method === "POST") return { action: `${resource}.${segments[1]}`, target: null };
		return {
			action: `${resource}.${method === "DELETE" ? "delete" : "update"}`,
			target: segments[1] ?? null,
		};
	}
	// /api/<resource>/<id>/<operation>[/...]
	return { action: `${resource}.${segments[2]}`, target: segments[1] ?? null };
}

export function outcomeForStatus(status: number): AuditOutcome {
	if (status < 400) return "ok";
	if (status >= 500) return "error";
	return "denied";
}
