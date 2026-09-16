// spec/09-api.md §7 and spec/05-skills-and-tools.md §§B.1-B.3 — the tool catalog routes.
import type { ApiErrorBody, SearchTestResponse, ToolsResponse } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { withTestApp } from "../support/app.js";

const json = { "content-type": "application/json" };

const BRAVE = {
	env: { PIUI_SEARCH_PROVIDER: "brave", PIUI_SEARCH_API_KEY: "brave-key" },
	fetch: (async () =>
		new Response(
			JSON.stringify({
				web: {
					results: [
						{ title: "Hit one", url: "https://example.com/1", description: "First" },
						{ title: "Hit two", url: "https://example.com/2", description: "Second" },
					],
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as unknown as typeof fetch,
};

describe("GET /api/tools", () => {
	it("[09-api#7] returns the whole catalog with usedByProfiles and the web-search status", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({ method: "GET", url: "/api/tools", headers: mint().headers });
			expect(res.statusCode).toBe(200);
			const body = res.json<ToolsResponse>();

			const names = body.items.map((item) => item.name);
			expect(names).toEqual(expect.arrayContaining(["read", "bash", "web_search", "web_fetch"]));
			for (const item of body.items) expect(item.usedByProfiles).toBe(0);
			// the default temp home has PIUI_SEARCH_PROVIDER=none
			expect(body.webSearch).toEqual({ provider: "none", configured: false });
			expect(body.items.find((item) => item.name === "web_search")!.enabled).toBe(false);
		});
	});

	it("[09-api#7] reports the configured provider and enables the web tools", async () => {
		await withTestApp(async ({ app, mint }) => {
			const body = (
				await app.inject({ method: "GET", url: "/api/tools", headers: mint().headers })
			).json<ToolsResponse>();
			expect(body.webSearch).toEqual({ provider: "brave", configured: true });
			expect(body.items.find((item) => item.name === "web_search")!.enabled).toBe(true);
		}, BRAVE);
	});
});

describe("PATCH /api/tools/:name", () => {
	it("[09-api#7] globally disables a built-in for an admin", async () => {
		await withTestApp(async ({ app, mint }) => {
			const admin = mint();
			const res = await app.inject({
				method: "PATCH",
				url: "/api/tools/bash",
				headers: { ...admin.headers, ...json },
				payload: { enabled: false },
			});
			expect(res.statusCode).toBe(200);
			expect(res.json<{ name: string; enabled: boolean }>()).toMatchObject({
				name: "bash",
				enabled: false,
			});

			const list = (
				await app.inject({ method: "GET", url: "/api/tools", headers: admin.headers })
			).json<ToolsResponse>();
			expect(list.items.find((item) => item.name === "bash")!.enabled).toBe(false);

			// and back on again
			await app.inject({
				method: "PATCH",
				url: "/api/tools/bash",
				headers: { ...admin.headers, ...json },
				payload: { enabled: true },
			});
			const relisted = (
				await app.inject({ method: "GET", url: "/api/tools", headers: admin.headers })
			).json<ToolsResponse>();
			expect(relisted.items.find((item) => item.name === "bash")!.enabled).toBe(true);
		});
	});

	it("[09-api#7] answers 404 for a tool that is not in the catalog", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({
				method: "PATCH",
				url: "/api/tools/nope",
				headers: { ...mint().headers, ...json },
				payload: { enabled: false },
			});
			expect(res.statusCode).toBe(404);
			expect(res.json<ApiErrorBody>().error.code).toBe("not_found");
		});
	});

	it("[18-multi-user#9.3] stays admin-only now that the route exists", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({
				method: "PATCH",
				url: "/api/tools/bash",
				headers: { ...mint({ id: "bob", role: "user" }).headers, ...json },
				payload: { enabled: false },
			});
			expect(res.statusCode).toBe(403);
			expect(res.json<ApiErrorBody>().error.code).toBe("forbidden");
		});
	});
});

describe("POST /api/tools/web_search/test", () => {
	it("[09-api#7] answers 503 provider_not_configured when no provider is set", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({
				method: "POST",
				url: "/api/tools/web_search/test",
				headers: { ...mint().headers, ...json },
				payload: { query: "node lts" },
			});
			expect(res.statusCode).toBe(503);
			expect(res.json<ApiErrorBody>().error.code).toBe("provider_not_configured");
		});
	});

	it("[09-api#7] returns the provider's top results", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({
				method: "POST",
				url: "/api/tools/web_search/test",
				headers: { ...mint().headers, ...json },
				payload: { query: "node lts" },
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<SearchTestResponse>();
			expect(body.provider).toBe("brave");
			expect(body.results.map((r) => r.url)).toEqual([
				"https://example.com/1",
				"https://example.com/2",
			]);
		}, BRAVE);
	});
});
