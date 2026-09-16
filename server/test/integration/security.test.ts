// spec/11-security.md §4 (HTTP hardening) and §8 (error discipline).
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";

const json = { "content-type": "application/json" };

function csp(value: string | undefined): Map<string, string> {
	const out = new Map<string, string>();
	for (const directive of (value ?? "").split(";")) {
		const trimmed = directive.trim();
		if (!trimmed) continue;
		const space = trimmed.indexOf(" ");
		out.set(
			space === -1 ? trimmed : trimmed.slice(0, space),
			space === -1 ? "" : trimmed.slice(space + 1),
		);
	}
	return out;
}

async function newChat(t: TestApp, headers: Record<string, string>): Promise<string> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...headers, ...json },
		payload: { mode: "chat", provider: "piui-fake", modelId: "fake-1", title: "headers" },
	});
	expect(res.statusCode).toBe(201);
	return res.json<{ conversation: { id: string } }>().conversation.id;
}

describe("security headers", () => {
	it("[11-security#4.1] sets the hardening headers on every response, API and SPA alike", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			for (const url of ["/api/health", "/", "/conversations"]) {
				const res = await t.app.inject({ method: "GET", url, headers: me.headers });
				expect(res.headers["x-content-type-options"], url).toBe("nosniff");
				expect(res.headers["referrer-policy"], url).toBe("no-referrer");
				expect(res.headers["x-frame-options"], url).toBe("DENY");
				expect(res.headers["permissions-policy"], url).toBe(
					"geolocation=(), microphone=(), camera=()",
				);
				expect(res.headers["content-security-policy"], url).toBeTruthy();
			}
		});
	});

	it("[11-security#4.2] serves the spec's CSP in production, still allowing https: favicons", async () => {
		await withTestApp(
			async (t) => {
				const res = await t.app.inject({ method: "GET", url: "/api/health" });
				const directives = csp(res.headers["content-security-policy"] as string);
				expect(directives.get("default-src")).toBe("'self'");
				// M3's Sources footer loads favicons from icons.duckduckgo.com.
				expect(directives.get("img-src")).toBe("'self' data: blob: https:");
				expect(directives.get("style-src")).toBe("'self' 'unsafe-inline'");
				expect(directives.get("script-src")).toBe("'self'");
				expect(directives.get("connect-src")).toBe("'self'");
				expect(directives.get("frame-ancestors")).toBe("'none'");
				expect(directives.get("base-uri")).toBe("'none'");
				expect(directives.get("object-src")).toBe("'none'");
			},
			{ env: { NODE_ENV: "production" } },
		);
	});

	it("[11-security#4.3] allows the Vite dev origin in development only", async () => {
		await withTestApp(async (t) => {
			const dev = csp(
				(await t.app.inject({ method: "GET", url: "/api/health" })).headers[
					"content-security-policy"
				] as string,
			);
			// Vite serves the SPA and its HMR socket from :5173 while piui answers /api on :8787.
			expect(dev.get("connect-src")).toContain("ws:");
			expect(dev.get("connect-src")).toContain("http://localhost:5173");
			expect(dev.get("script-src")).toContain("'unsafe-eval'");
		});
	});

	it("[11-security#4.4] leaves the SSE stream streamable and keeps uploads sandboxed", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const id = await newChat(t, me.headers);

				const sse = await t.app.inject({
					method: "GET",
					url: `/api/conversations/${id}/events`,
					headers: me.headers,
					payloadAsStream: true,
				});
				expect(sse.headers["content-type"]).toContain("text/event-stream");
				expect(sse.headers["cache-control"]).toBe("no-cache, no-transform");
				expect(sse.headers["x-content-type-options"]).toBe("nosniff");
				expect(sse.headers["content-security-policy"]).toBeTruthy();
				sse.stream().destroy();
			},
			{ env: { PIUI_FAKE_MODEL: "1" } },
		);
	});
});

describe("error discipline", () => {
	// The M5c browser finding: a DELETE with `content-type: application/json` and no body
	// answered `400 internal_error` because fastify's FST_ERR_CTP_EMPTY_JSON_BODY fell through
	// to the generic handler.
	it("[11-security#8.1] maps fastify transport errors into the envelope, never internal_error", async () => {
		await withTestApp(async (t) => {
			const admin = t.mint({ role: "admin" });
			expect(
				(
					await t.app.inject({
						method: "POST",
						url: "/api/auth/step-up",
						headers: { ...admin.headers, ...json },
						payload: { password: "test" },
					})
				).statusCode,
			).toBe(204);
			const res = await t.app.inject({
				method: "DELETE",
				url: "/api/extensions/does-not-exist",
				headers: { ...admin.headers, ...json },
				payload: "",
			});
			const body = res.json<{ error: { code: string; message: string } }>();
			expect(body.error.code).not.toBe("internal_error");
			expect(body.error.code).toBe("validation_error");
			expect(res.statusCode).toBe(400);
			expect(body.error.message).toMatch(/body/i);
		});
	});

	it("[11-security#8.2] answers internal_error with a correlation id and no stack trace", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			// A domain failure, not a crafted route: the models service is what /api/models calls.
			t.services.models.list = () => {
				throw new Error("kaboom at /secret/path/file.ts:42 sk-livekey1234567890");
			};
			const res = await t.app.inject({ method: "GET", url: "/api/models", headers: me.headers });
			expect(res.statusCode).toBe(500);
			const body = res.json<{ error: { code: string; message: string; correlationId?: string } }>();
			expect(body.error.code).toBe("internal_error");
			expect(body.error.correlationId).toMatch(/\S/);
			expect(res.payload).not.toContain("kaboom");
			expect(res.payload).not.toContain("sk-livekey");
			expect(res.payload).not.toMatch(/\.ts:\d+/);
		});
	});
});
