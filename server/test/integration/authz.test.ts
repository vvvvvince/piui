// spec/18-multi-user.md §9.3 and §5 — the admin-only surface, and step-up (14-credentials §5).
import { describe, expect, it } from "vitest";
import { withTestApp } from "../support/app.js";

/** Every admin-only surface of spec/18-multi-user.md §5, as (method, path) pairs. */
const ADMIN_ONLY: [string, string][] = [
	["GET", "/api/providers"],
	["POST", "/api/providers/anthropic/auth/start"],
	["DELETE", "/api/providers/anthropic/auth"],
	["GET", "/api/extensions"],
	["POST", "/api/extensions/install"],
	["PATCH", "/api/tools/web_search"],
	["POST", "/api/skills/rescan"],
	["POST", "/api/prompts/rescan"],
	["POST", "/api/extensions/rescan"],
	["GET", "/api/users"],
	["POST", "/api/users"],
	["GET", "/api/settings"],
	["PATCH", "/api/settings"],
	["GET", "/api/audit"],
	["GET", "/api/fs/browse?path=/"],
];

const OPEN_TO_USERS: [string, string][] = [
	["GET", "/api/auth/me"],
	["GET", "/api/meta"],
];

describe("authorization", () => {
	it('[18-multi-user#9.3] answers 403 to a role:"user" principal on every admin-only route', async () => {
		await withTestApp(async ({ app, mint }) => {
			const user = mint({ id: "bob", role: "user" });
			for (const [method, url] of ADMIN_ONLY) {
				const res = await app.inject({ method: method as "GET", url, headers: user.headers });
				expect(res.statusCode, `${method} ${url}`).toBe(403);
				const body = res.json<{ error: { code: string; message: string } }>();
				expect(body.error.code).toBe("forbidden");
				expect(body.error.message, `${method} ${url}`).toMatch(/admin/);
			}
		});
	});

	it('[18-multi-user#9.3] answers 200 to a role:"user" principal on everything else', async () => {
		await withTestApp(async ({ app, mint }) => {
			const user = mint({ id: "bob", role: "user" });
			for (const [method, url] of OPEN_TO_USERS) {
				const res = await app.inject({ method: method as "GET", url, headers: user.headers });
				expect(res.statusCode, `${method} ${url}`).toBe(200);
			}
		});
	});

	it("[18-multi-user#9.3] lets the seeded admin past the role guard", async () => {
		await withTestApp(async ({ app, mint }) => {
			const admin = mint();
			for (const [method, url] of ADMIN_ONLY) {
				const res = await app.inject({ method: method as "GET", url, headers: admin.headers });
				// the surfaces themselves land in M2–M6; what matters here is that the role guard
				// never fires (a credential write may still demand a step-up).
				const code =
					res.statusCode === 204 ? "" : res.json<{ error?: { code: string } }>().error?.code;
				expect(code, `${method} ${url}`).not.toBe("forbidden");
			}
		});
	});

	it("keeps /api/users/* non-existent in V1 for admins (spec/09-api.md §7a)", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({ method: "GET", url: "/api/users", headers: mint().headers });
			expect(res.statusCode).toBe(404);
		});
	});
});

describe("step-up re-authentication", () => {
	const START = "/api/providers/anthropic/auth/start";

	it("[14-credentials#9.7] requires a step-up on credential writes, and expires it after 10 minutes", async () => {
		await withTestApp(async ({ app, ctx, clock, mint }) => {
			const admin = mint();
			const headers = { ...admin.headers, "content-type": "application/json" };

			// no step-up on this session yet
			const blocked = await app.inject({ method: "POST", url: START, headers, payload: {} });
			expect(blocked.statusCode).toBe(403);
			expect(blocked.json()).toEqual({
				error: { code: "step_up_required", message: expect.any(String) },
			});

			const up = await app.inject({
				method: "POST",
				url: "/api/auth/step-up",
				headers,
				payload: { password: "test" },
			});
			expect(up.statusCode).toBe(204);
			expect(ctx.repos.authSessions.get(admin.sessionId)?.step_up_at).toBe(clock.nowIso());

			// within the window the guard is transparent (the route itself arrives in M2)
			const passed = await app.inject({ method: "POST", url: START, headers, payload: {} });
			expect(passed.statusCode).toBe(404);

			clock.advance(11 * 60_000);
			const expired = await app.inject({ method: "POST", url: START, headers, payload: {} });
			expect(expired.statusCode).toBe(403);
			expect(expired.json<{ error: { code: string } }>().error.code).toBe("step_up_required");
		});
	});

	it("[14-credentials#9.7] never gates GET /api/providers behind a step-up", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({
				method: "GET",
				url: "/api/providers",
				headers: mint().headers,
			});
			expect(res.statusCode).toBe(404);
		});
	});

	it("[14-credentials#9.7] rejects a wrong step-up password with 401 and the login delay", async () => {
		await withTestApp(async ({ app, ctx, mint, sleeps }) => {
			const admin = mint();
			const res = await app.inject({
				method: "POST",
				url: "/api/auth/step-up",
				headers: { ...admin.headers, "content-type": "application/json" },
				payload: { password: "wrong" },
			});
			expect(res.statusCode).toBe(401);
			expect(res.json<{ error: { code: string } }>().error.code).toBe("invalid_credentials");
			expect(sleeps).toEqual([250]);
			expect(ctx.repos.authSessions.get(admin.sessionId)?.step_up_at).toBeNull();
		});
	});

	it("[14-credentials#9.7] counts a fresh login as a step-up", async () => {
		await withTestApp(async ({ app }) => {
			const login = await app.inject({
				method: "POST",
				url: "/api/auth/login",
				headers: { "x-requested-with": "piui", "content-type": "application/json" },
				payload: { username: "test", password: "test" },
			});
			const cookie = `piui_sid=${login.cookies.find((c) => c.name === "piui_sid")!.value}`;
			const res = await app.inject({
				method: "POST",
				url: "/api/providers/anthropic/auth/start",
				headers: { cookie, "x-requested-with": "piui", "content-type": "application/json" },
				payload: {},
			});
			expect(res.statusCode).toBe(404);
		});
	});

	it("[14-credentials#9.7] rate-limits step-up attempts with the login limiter", async () => {
		await withTestApp(async ({ app, mint }) => {
			const admin = mint();
			const headers = { ...admin.headers, "content-type": "application/json" };
			for (let i = 0; i < 10; i += 1) {
				const res = await app.inject({
					method: "POST",
					url: "/api/auth/step-up",
					headers,
					payload: { password: "wrong" },
				});
				expect(res.statusCode).toBe(401);
			}
			const limited = await app.inject({
				method: "POST",
				url: "/api/auth/step-up",
				headers,
				payload: { password: "test" },
			});
			expect(limited.statusCode).toBe(429);
		});
	});
});
