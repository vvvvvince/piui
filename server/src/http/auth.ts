// Authentication: pluggable provider, server-side sessions, cookies, CSRF, brute-force
// protection and step-up re-auth. spec/06-auth.md, spec/14-credentials.md §5.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoginResponse, MeResponse, Principal } from "@piui/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest, RawServerDefault } from "fastify";
import type { Logger } from "pino";
import type { AppContext } from "../context.js";
import { isAdminOnly, requiresStepUp, STEP_UP_WINDOW_MS } from "./authz.js";
import { ApiError } from "./errors.js";

declare module "fastify" {
	interface FastifyRequest {
		/** Set by the auth guard on every authenticated request. */
		principal?: Principal;
		sessionId?: string;
	}
}

// ---------------------------------------------------------------- provider

export interface AuthProvider {
	readonly id: string;
	/** Returns the authenticated principal, or null on bad credentials. */
	verify(credentials: { username: string; password: string }): Promise<Principal | null>;
}

/** Constant-time string comparison: hash both sides first so lengths always match. */
export function timingSafeEqualStr(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a, "utf8").digest();
	const hb = createHash("sha256").update(b, "utf8").digest();
	return timingSafeEqual(ha, hb);
}

/**
 * V1 provider: a single set of credentials from config (`PIUI_USERNAME` / `PIUI_PASSWORD`,
 * defaulting to test/test). Replacing it is a one-line change in `createContext`.
 */
export class StaticAuthProvider implements AuthProvider {
	readonly id = "static";

	constructor(
		private readonly username: string,
		private readonly password: string,
		private readonly displayName = "Local user",
	) {}

	async verify(credentials: { username: string; password: string }): Promise<Principal | null> {
		const okUser = timingSafeEqualStr(credentials.username, this.username);
		const okPass = timingSafeEqualStr(credentials.password, this.password);
		if (!(okUser && okPass)) return null;
		return {
			id: "local",
			username: this.username,
			displayName: this.displayName,
			roles: ["admin"],
		};
	}
}

// ---------------------------------------------------------------- sessions

export const SESSION_COOKIE = "piui_sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const FAILED_LOGIN_DELAY_MS = 250;

export function signSessionId(sessionId: string, secret: string): string {
	return `${sessionId}.${createHmac("sha256", secret).update(sessionId).digest("hex")}`;
}

/** Returns the session id when the cookie is intact, null when it is absent or tampered with. */
export function verifySessionCookie(value: string | undefined, secret: string): string | null {
	if (!value) return null;
	const dot = value.lastIndexOf(".");
	if (dot <= 0) return null;
	const sessionId = value.slice(0, dot);
	const mac = Buffer.from(value.slice(dot + 1), "utf8");
	const expected = Buffer.from(
		createHmac("sha256", secret).update(sessionId).digest("hex"),
		"utf8",
	);
	if (mac.length !== expected.length) return null;
	return timingSafeEqual(mac, expected) ? sessionId : null;
}

// ------------------------------------------------------------ rate limiter

/** Per-IP sliding window (spec/06-auth.md §4): 10 failures / 5 min, then 429. */
export class LoginRateLimiter {
	private readonly hits = new Map<string, number[]>();

	constructor(
		private readonly nowMs: () => number,
		readonly limit = 10,
		readonly windowMs = 5 * 60 * 1000,
	) {}

	/** Seconds the caller must wait, or 0 when the request may proceed. */
	retryAfter(key: string): number {
		const window = this.prune(key);
		if (window.length < this.limit) return 0;
		const oldest = window[0]!;
		return Math.max(1, Math.ceil((oldest + this.windowMs - this.nowMs()) / 1000));
	}

	recordFailure(key: string): void {
		const window = this.prune(key);
		window.push(this.nowMs());
		this.hits.set(key, window);
	}

	private prune(key: string): number[] {
		const cutoff = this.nowMs() - this.windowMs;
		const window = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
		if (window.length === 0) this.hits.delete(key);
		else this.hits.set(key, window);
		return window;
	}

	/** Drops empty windows; called from the session sweep interval. */
	sweep(): void {
		for (const key of [...this.hits.keys()]) this.prune(key);
	}
}

// ------------------------------------------------------------------ guards

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC: [string, string][] = [
	["POST", "/api/auth/login"],
	["GET", "/api/health"],
];

const pathOf = (url: string): string => url.split("?")[0]!.replace(/\/+$/, "") || "/";

function isPublic(method: string, url: string): boolean {
	const path = pathOf(url);
	return PUBLIC.some(([m, p]) => m === method && p === path);
}

/** spec/06-auth.md §5. */
function checkCsrf(req: FastifyRequest): void {
	if (!MUTATING.has(req.method)) return;

	const origin = req.headers.origin ?? req.headers.referer;
	if (origin) {
		let originHost: string | null = null;
		try {
			originHost = new URL(origin).host;
		} catch {
			originHost = null;
		}
		// `req.host` honours X-Forwarded-Host when trustProxy is on, so a TLS terminator in
		// front of piui keeps working.
		const selfHosts = [req.host, req.headers.host].filter(Boolean);
		if (originHost === null || !selfHosts.includes(originHost)) {
			throw new ApiError("csrf_check_failed", "Request origin does not match this server.");
		}
	}

	const requestedWith = req.headers["x-requested-with"];
	if (typeof requestedWith === "string" && requestedWith.toLowerCase() === "piui") return;

	const contentType = (req.headers["content-type"] ?? "").toLowerCase();
	if (contentType.startsWith("application/json")) return;

	throw new ApiError(
		"csrf_check_failed",
		"Mutating requests must send the X-Requested-With: piui header or a JSON body.",
	);
}

/** preHandler factory for routes that must be admin-only without matching a path pattern. */
export function requireAdmin(req: FastifyRequest): void {
	if (!req.principal?.roles.includes("admin")) {
		throw new ApiError("forbidden", "This action requires the admin role.");
	}
}

export interface AuthDeps {
	ctx: AppContext;
	provider: AuthProvider;
	limiter: LoginRateLimiter;
}

/** preHandler factory for step-up-gated routes (spec/14-credentials.md §5). */
export function requireStepUp(ctx: AppContext) {
	return (req: FastifyRequest): void => {
		if (!stepUpValidUntil(ctx, req.sessionId)) {
			throw new ApiError("step_up_required", "Confirm your password to continue.");
		}
	};
}

function stepUpValidUntil(ctx: AppContext, sessionId: string | undefined): string | null {
	if (!sessionId) return null;
	const row = ctx.repos.authSessions.get(sessionId);
	if (!row?.step_up_at) return null;
	const until = new Date(row.step_up_at).getTime() + STEP_UP_WINDOW_MS;
	return until > ctx.clock.nowMs() ? new Date(until).toISOString() : null;
}

// ------------------------------------------------------------------- plugin

/** The server is built with a concrete pino logger, so the instance type is pinned here too. */
export type PiuiFastify = FastifyInstance<
	RawServerDefault,
	IncomingMessage,
	ServerResponse,
	Logger
>;

export async function registerAuth(app: PiuiFastify, deps: AuthDeps): Promise<void> {
	const { ctx, provider, limiter } = deps;

	const cookieOptions = (req: FastifyRequest) => ({
		httpOnly: true,
		sameSite: "lax" as const,
		path: "/",
		maxAge: Math.floor(SESSION_TTL_MS / 1000),
		secure: ctx.config.forceSecureCookie || req.protocol === "https",
	});

	const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, sessionId: string): void => {
		reply.setCookie(
			SESSION_COOKIE,
			signSessionId(sessionId, ctx.config.sessionSecret),
			cookieOptions(req),
		);
	};

	// onRequest (not preHandler): runs before body parsing, so a hostile content-type is rejected
	// before Fastify tries to parse it, and unknown routes are guarded too.
	app.addHook("onRequest", async (req) => {
		if (!req.url.startsWith("/api/")) return;

		checkCsrf(req);
		if (isPublic(req.method, req.url)) return;

		const raw = req.cookies[SESSION_COOKIE];
		const sessionId = verifySessionCookie(raw, ctx.config.sessionSecret);
		if (!sessionId) throw new ApiError("unauthenticated", "Authentication required.");

		const session = ctx.repos.authSessions.getLive(sessionId);
		if (!session) throw new ApiError("unauthenticated", "Your session has expired.");

		const user = ctx.repos.users.get(session.user_id);
		if (user?.active !== 1) {
			ctx.repos.authSessions.delete(sessionId);
			throw new ApiError("unauthenticated", "Authentication required.");
		}

		req.principal = ctx.repos.users.toPrincipal(user);
		req.sessionId = sessionId;

		if (isAdminOnly(req.method, req.url)) requireAdmin(req);
		if (requiresStepUp(req.method, req.url) && !stepUpValidUntil(ctx, sessionId)) {
			throw new ApiError("step_up_required", "Confirm your password to continue.");
		}
	});

	// Sliding expiry (spec/06-auth.md §2): refresh at most once a day.
	app.addHook("onSend", async (req, reply, payload) => {
		const sessionId = req.sessionId;
		if (!sessionId) return payload;
		const session = ctx.repos.authSessions.get(sessionId);
		if (!session) return payload;
		const lastRefresh = new Date(session.expires_at).getTime() - SESSION_TTL_MS;
		if (ctx.clock.nowMs() - lastRefresh > REFRESH_AFTER_MS) {
			ctx.repos.authSessions.extend(sessionId, SESSION_TTL_MS);
			setSessionCookie(req, reply, sessionId);
		}
		return payload;
	});

	const credentialsSchema = {
		type: "object",
		required: ["username", "password"],
		additionalProperties: false,
		properties: { username: { type: "string" }, password: { type: "string" } },
	};

	/** Shared by login and step-up: rate limit, verify, constant delay on failure. */
	async function verifyPassword(
		req: FastifyRequest,
		credentials: { username: string; password: string },
		reply: FastifyReply,
	): Promise<Principal | null> {
		const key = req.ip;
		const retryAfter = limiter.retryAfter(key);
		if (retryAfter > 0) {
			reply.header("Retry-After", String(retryAfter));
			throw new ApiError("rate_limited", "Too many attempts. Try again later.");
		}
		const principal = await provider.verify(credentials);
		if (!principal) {
			limiter.recordFailure(key);
			await ctx.sleep(FAILED_LOGIN_DELAY_MS);
			return null;
		}
		return principal;
	}

	app.post<{ Body: { username: string; password: string } }>(
		"/api/auth/login",
		{ schema: { body: credentialsSchema } },
		async (req, reply): Promise<LoginResponse> => {
			const principal = await verifyPassword(req, req.body, reply);
			if (!principal) throw new ApiError("invalid_credentials", "Invalid username or password.");

			const user = ctx.repos.users.get(principal.id);
			if (user?.active !== 1) {
				throw new ApiError("invalid_credentials", "Invalid username or password.");
			}

			const sessionId = randomBytes(32).toString("hex");
			ctx.repos.authSessions.create({
				id: sessionId,
				userId: user.id,
				username: principal.username,
				ttlMs: SESSION_TTL_MS,
				userAgent: req.headers["user-agent"] ?? null,
			});
			// A fresh login counts as a step-up (spec/14-credentials.md §5).
			ctx.repos.authSessions.markStepUp(sessionId);
			setSessionCookie(req, reply, sessionId);
			req.log.info({ user: user.id }, "login");
			return { user: principal };
		},
	);

	app.post("/api/auth/logout", async (req, reply) => {
		if (req.sessionId) ctx.repos.authSessions.delete(req.sessionId);
		req.sessionId = undefined;
		reply.clearCookie(SESSION_COOKIE, { path: "/" });
		return reply.status(204).send();
	});

	app.get("/api/auth/me", async (req): Promise<MeResponse> => {
		return {
			user: req.principal!,
			stepUpValidUntil: stepUpValidUntil(ctx, req.sessionId),
		};
	});

	app.post<{ Body: { password: string } }>(
		"/api/auth/step-up",
		{
			schema: {
				body: {
					type: "object",
					required: ["password"],
					additionalProperties: false,
					properties: { password: { type: "string" } },
				},
			},
		},
		async (req, reply) => {
			const principal = await verifyPassword(
				req,
				{ username: req.principal!.username, password: req.body.password },
				reply,
			);
			if (!principal) throw new ApiError("invalid_credentials", "Invalid password.");
			ctx.repos.authSessions.markStepUp(req.sessionId!);
			return reply.status(204).send();
		},
	);
}
