import type { HealthResponse, MetaResponse } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { withTestApp } from "../support/app.js";

describe("GET /api/health", () => {
	it("[12-milestones#M0.2] returns ok with version and deployment posture", async () => {
		await withTestApp(async ({ app }) => {
			const res = await app.inject({ method: "GET", url: "/api/health" });
			expect(res.statusCode).toBe(200);
			const body = res.json<HealthResponse>();
			expect(body.ok).toBe(true);
			expect(body.piVersion).toMatch(/^\d+\.\d+\.\d+/);
			expect(body.defaultCredentials).toBe(true);
			expect(body.container).toBe(false);
			expect(body.insecureTransportOk).toBe(false);
		});
	});

	it("[19-deployment#9.8] reports container and insecure-transport acknowledgement", async () => {
		await withTestApp(
			async ({ app }) => {
				const body = (
					await app.inject({ method: "GET", url: "/api/health" })
				).json<HealthResponse>();
				expect(body.container).toBe(true);
				expect(body.insecureTransportOk).toBe(true);
			},
			{ env: { PIUI_CONTAINER: "1", PIUI_INSECURE_TRANSPORT_OK: "1" } },
		);
	});
});

describe("GET /api/meta", () => {
	it("reports limits, search provider and workspace roots", async () => {
		await withTestApp(async ({ app, mint }) => {
			const body = (
				await app.inject({ method: "GET", url: "/api/meta", headers: mint().headers })
			).json<MetaResponse>();
			expect(body.searchProvider).toEqual({ id: "none", configured: false });
			expect(body.limits).toEqual({ maxUploadMb: 10, maxConcurrentRuns: 4, maxRunMinutes: 30 });
			expect(body.workspaceRoots).toEqual([]);
		});
	});
});

describe("error envelope", () => {
	it("[09-api#0.1] unknown API routes return the standard error shape", async () => {
		await withTestApp(async ({ app, mint }) => {
			const res = await app.inject({
				method: "GET",
				url: "/api/nope",
				headers: mint().headers,
			});
			expect(res.statusCode).toBe(404);
			expect(res.json()).toEqual({
				error: { code: "not_found", message: expect.stringContaining("No route") },
			});
		});
	});
});
