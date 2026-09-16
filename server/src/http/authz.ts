// spec/18-multi-user.md §5 — the admin-only surface, and spec/14-credentials.md §5 — the
// step-up surface, expressed as (method, path) matchers.
//
// Why matchers instead of per-route preHandlers: the guarded surfaces land across M2–M6, and a
// route that does not exist yet must still be guarded (a missing `requireAdmin` on a route added
// in M6 would otherwise be silent). `requireAdmin` / `requireStepUp` in auth.ts remain available
// for routes that need the check without matching a pattern.

export type HttpMethod = string;

const strip = (url: string): string => url.split("?")[0]!.replace(/\/+$/, "") || "/";

const ADMIN_PREFIXES = [
	"/api/providers",
	"/api/extensions",
	"/api/users",
	"/api/settings",
	"/api/audit",
];

/** spec/18-multi-user.md §5. */
export function isAdminOnly(method: HttpMethod, url: string): boolean {
	const path = strip(url);
	if (ADMIN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return true;
	// global tool enable/disable: PATCH /api/tools/:name (HTTP-tool CRUD lives under /http/)
	if (method === "PATCH" && /^\/api\/tools\/[^/]+$/.test(path) && path !== "/api/tools/http") {
		return true;
	}
	// every rescan endpoint
	if (method === "POST" && path.endsWith("/rescan")) return true;
	// the filesystem picker enumerates the machine
	if (method === "GET" && path === "/api/fs/browse") return true;
	return false;
}

/**
 * spec/14-credentials.md §5: every credential route except `GET /api/providers` requires a
 * step-up performed within the last 10 minutes.
 */
export function requiresStepUp(method: HttpMethod, url: string): boolean {
	const path = strip(url);
	// spec/16-extensions.md §7.4.1 — installing, editing, deleting or toggling an extension is
	// running code on this machine: every mutation is step-up gated, reads are not.
	if (path === "/api/extensions" || path.startsWith("/api/extensions/")) return method !== "GET";
	if (!(path === "/api/providers" || path.startsWith("/api/providers/"))) return false;
	return !(method === "GET" && path === "/api/providers");
}

/** spec/14-credentials.md §5. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
