// spec/06-auth.md §8 — the route-guard matrix, driven through fastify.inject().
import type { LoginResponse, MeResponse, Principal } from "@piui/shared";
import { describe, expect, it } from "vitest";
import type { AuthProvider } from "../../src/http/auth.js";
import { type createTestApp, withTestApp } from "../support/app.js";
import { SESSION_COOKIE } from "../support/principal.js";

const JSON_HEADERS = { "x-requested-with": "piui", "content-type": "application/json" };

async function login(
	app: Awaited<ReturnType<typeof createTestApp>>["app"],
	username = "test",
	password = "test",
) {
	return app.inject({
		method: "POST",
		url: "/api/auth/login",
		headers: JSON_HEADERS,
		payload: { username, password },
	});
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
	const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
	if (!cookie) throw new Error("no session cookie was set");
	return `${SESSION_COOKIE}=${cookie.value}`;
}

describe("authentication", () => {
	it("[06-auth#8.1] rejects any /api/* call without a cookie, but not health or login", async () => {
		await withTestApp(async ({ app }) => {
			const res = await app.inject({ method: "GET", url: "/api/meta" });
			expect(res.statusCode).toBe(401);
			expect(res.json()).toEqual({
				error: { code: "unauthenticated", message: expect.any(String) },
			});

			expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
			expect((await login(app, "test", "nope")).statusCode).toBe(401);
		});
	});

	it("[06-auth#8.1] protects GET /api/auth/me the same way", async () => {
		await withTestApp(async ({ app }) => {
			const res = await app.inject({ method: "GET", url: "/api/auth/me" });
			expect(res.statusCode).toBe(401);
		});
	});

	it("[06-auth#8.2] logs in with test/test and returns the principal", async () => {
		await withTestApp(async ({ app, ctx }) => {
			const res = await login(app);
			expect(res.statusCode).toBe(200);
			const body = res.json<LoginResponse>();
			expect(body.user).toEqual({
				id: "local",
				username: "test",
				displayName: expect.any(String),
				roles: ["admin"],
			});

			const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
			expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
			expect(cookie?.value).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
			expect(cookie?.maxAge).toBe(2592000);
			expect(cookie?.secure).toBeFalsy();

			const sessionId = cookie!.value.split(".")[0]!;
			const row = ctx.repos.authSessions.get(sessionId);
			expect(row?.user_id).toBe("local");
			// a fresh login counts as a step-up (spec/14-credentials.md §5)
			expect(row?.step_up_at).toBe(row?.created_at);

			const me = await app.inject({
				method: "GET",
				url: "/api/auth/me",
				headers: { cookie: cookieOf(res) },
			});
			expect(me.statusCode).toBe(200);
			const meBody = me.json<MeResponse>();
			expect(meBody.user.roles).toEqual(["admin"]);
			expect(meBody.stepUpValidUntil).toBe(new Date(ctx.clock.nowMs() + 600_000).toISOString());
		});
	});

	it("[06-auth#8.2] rejects a bad password with 401 after a ~250 ms delay", async () => {
		await withTestApp(async ({ app, sleeps }) => {
			const res = await login(app, "test", "wrong");
			expect(res.statusCode).toBe(401);
			expect(res.json()).toEqual({
				error: { code: "invalid_credentials", message: expect.any(String) },
			});
			expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
			expect(sleeps).toEqual([250]);
		});
	});

	it("[06-auth#8.2] gives a generic error for an unknown username (no enumeration)", async () => {
		await withTestApp(async ({ app }) => {
			const unknown = await login(app, "nobody", "test");
			const wrong = await login(app, "test", "wrong");
			expect(unknown.statusCode).toBe(401);
			expect(unknown.json()).toEqual(wrong.json());
		});
	});

	it("[06-auth#8.2] rate-limits: the 11th rapid failure returns 429 with Retry-After", async () => {
		await withTestApp(async ({ app, clock }) => {
			for (let i = 0; i < 10; i += 1) {
				expect((await login(app, "test", "wrong")).statusCode).toBe(401);
			}
			const limited = await login(app, "test", "wrong");
			expect(limited.statusCode).toBe(429);
			expect(limited.json()).toEqual({
				error: { code: "rate_limited", message: expect.any(String) },
			});
			expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

			// even the correct password is refused while the window is open…
			expect((await login(app)).statusCode).toBe(429);
			// …and allowed again once it slides past
			clock.advance(5 * 60_000 + 1);
			expect((await login(app)).statusCode).toBe(200);
		});
	});

	it("[06-auth#8.3] invalidates the session server-side on logout", async () => {
		await withTestApp(async ({ app, ctx }) => {
			const cookie = cookieOf(await login(app));
			const sessionId = cookie.split("=")[1]!.split(".")[0]!;

			const out = await app.inject({
				method: "POST",
				url: "/api/auth/logout",
				headers: { cookie, "x-requested-with": "piui" },
			});
			expect(out.statusCode).toBe(204);
			expect(ctx.repos.authSessions.get(sessionId)).toBeUndefined();
			expect(out.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe("");

			const replay = await app.inject({
				method: "GET",
				url: "/api/auth/me",
				headers: { cookie },
			});
			expect(replay.statusCode).toBe(401);
		});
	});

	it("[06-auth#8.4] rejects a form-encoded POST without X-Requested-With as CSRF", async () => {
		await withTestApp(async ({ app, mint }) => {
			const { headers } = mint();
			const res = await app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: {
					cookie: headers.cookie,
					"content-type": "application/x-www-form-urlencoded",
				},
				payload: "name=evil",
			});
			expect(res.statusCode).toBe(403);
			expect(res.json()).toEqual({
				error: { code: "csrf_check_failed", message: expect.any(String) },
			});
		});
	});

	it("[06-auth#8.4] rejects a cross-origin mutation even with the header", async () => {
		await withTestApp(async ({ app, mint }) => {
			const { headers } = mint();
			const res = await app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...headers, "content-type": "application/json", origin: "https://evil.test" },
				payload: { name: "x" },
			});
			expect(res.statusCode).toBe(403);
			expect(res.json<{ error: { code: string } }>().error.code).toBe("csrf_check_failed");
		});
	});

	it("[06-auth#8.4] lets a GET through without the header", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({
				method: "GET",
				url: "/api/meta",
				headers: { cookie: mint().headers.cookie },
			});
			expect(res.statusCode).toBe(200);
		});
	});

	it("[06-auth#8.5] rejects a cookie whose HMAC has been tampered with", async () => {
		await withTestApp(async ({ app }) => {
			const cookie = cookieOf(await login(app));
			const [sid, mac] = cookie.split("=")[1]!.split(".");
			const flipped = `${mac!.slice(0, -1)}${mac!.endsWith("a") ? "b" : "a"}`;

			for (const value of [`${sid}.${flipped}`, sid!, `${sid}.`, "garbage"]) {
				const res = await app.inject({
					method: "GET",
					url: "/api/auth/me",
					headers: { cookie: `${SESSION_COOKIE}=${value}` },
				});
				expect(res.statusCode, `cookie ${value}`).toBe(401);
			}
		});
	});

	it("[06-auth#8.6] accepts a swapped AuthProvider without touching anything but the wiring", async () => {
		const stub: AuthProvider = {
			id: "stub",
			async verify({ username, password }): Promise<Principal | null> {
				return username === "ada" && password === "lovelace"
					? { id: "local", username: "ada", displayName: "Ada", roles: ["admin"] }
					: null;
			},
		};
		await withTestApp(
			async ({ app }) => {
				expect((await login(app, "test", "test")).statusCode).toBe(401);
				const ok = await login(app, "ada", "lovelace");
				expect(ok.statusCode).toBe(200);
				expect(ok.json<LoginResponse>().user.username).toBe("ada");
			},
			{ authProvider: stub },
		);
	});

	it("refuses an expired session and deletes the row lazily", async () => {
		await withTestApp(async ({ app, ctx, clock }) => {
			const cookie = cookieOf(await login(app));
			const sessionId = cookie.split("=")[1]!.split(".")[0]!;
			clock.advance(31 * 24 * 60 * 60 * 1000);
			const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
			expect(res.statusCode).toBe(401);
			expect(ctx.repos.authSessions.get(sessionId)).toBeUndefined();
		});
	});

	it("slides the expiry and re-sets the cookie after 24 h", async () => {
		await withTestApp(async ({ app, ctx, clock }) => {
			const cookie = cookieOf(await login(app));
			const sessionId = cookie.split("=")[1]!.split(".")[0]!;
			const before = ctx.repos.authSessions.get(sessionId)!.expires_at;

			const fresh = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
			expect(fresh.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();

			clock.advance(25 * 60 * 60 * 1000);
			const slid = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
			expect(slid.statusCode).toBe(200);
			expect(slid.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe(cookie.split("=")[1]);
			expect(ctx.repos.authSessions.get(sessionId)!.expires_at > before).toBe(true);
		});
	});

	it("marks the cookie Secure when the transport says so", async () => {
		await withTestApp(
			async ({ app }) => {
				const res = await login(app);
				expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
			},
			{ env: { PIUI_FORCE_SECURE_COOKIE: "1" } },
		);
	});

	it("refuses a session whose user has been deactivated", async () => {
		await withTestApp(async ({ app, ctx, mint }) => {
			const { headers } = mint({ id: "bob", role: "user" });
			expect((await app.inject({ method: "GET", url: "/api/auth/me", headers })).statusCode).toBe(
				200,
			);
			ctx.db.prepare("UPDATE users SET active = 0 WHERE id = 'bob'").run();
			expect((await app.inject({ method: "GET", url: "/api/auth/me", headers })).statusCode).toBe(
				401,
			);
		});
	});
});
