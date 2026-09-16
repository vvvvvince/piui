// spec/11-security.md §§4-5 — rate limits and DoS self-protection (the caps that must trip).
import type { ApiErrorBody } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { MAX_GLOBAL_SUBSCRIBERS, MAX_SUBSCRIBERS_PER_CONVERSATION } from "../../src/http/sse.js";
import { type TestApp, withTestApp } from "../support/app.js";

const json = { "content-type": "application/json" };
const FAKE = { env: { PIUI_FAKE_MODEL: "1" } };

async function newChat(t: TestApp, headers: Record<string, string>): Promise<string> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...headers, ...json },
		payload: { mode: "chat", provider: "piui-fake", modelId: "fake-1", title: "caps" },
	});
	expect(res.statusCode).toBe(201);
	return res.json<{ conversation: { id: string } }>().conversation.id;
}

describe("subscriber caps", () => {
	it("[11-security#5.1] refuses the ninth SSE subscriber on one conversation with 429", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const id = await newChat(t, me.headers);
			const streams = [];
			for (let i = 0; i < MAX_SUBSCRIBERS_PER_CONVERSATION - 1; i += 1) {
				streams.push(await t.openSse(`/api/conversations/${id}/events`, me));
			}
			// The last slot is taken by a plain subscriber, so the test can also free one.
			const release = t.services.hub.channel(id).subscribe(() => {});
			const refused = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${id}/events`,
				headers: me.headers,
			});
			expect(refused.statusCode).toBe(429);
			expect(refused.json<ApiErrorBody>().error.code).toBe("rate_limited");

			// closing one frees a slot again
			release();
			const accepted = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${id}/events`,
				headers: me.headers,
				payloadAsStream: true,
			});
			expect(accepted.statusCode).toBe(200);
			accepted.stream().destroy();
			for (const stream of streams) stream.stop();
		}, FAKE);
	});

	it("[11-security#5.2] caps subscribers on the global channel per process", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const streams = [];
			for (let i = 0; i < MAX_GLOBAL_SUBSCRIBERS; i += 1) {
				streams.push(await t.openGlobalEvents(me));
			}
			const refused = await t.app.inject({
				method: "GET",
				url: "/api/events",
				headers: me.headers,
			});
			expect(refused.statusCode).toBe(429);
			expect(refused.json<ApiErrorBody>().error.code).toBe("rate_limited");
			for (const stream of streams) stream.stop();
		});
	});
});

describe("rate limits", () => {
	it("[11-security#4.5] allows 60 messages a minute per session, then answers 429", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const id = await newChat(t, me.headers);
			// The conversation is busy after the first prompt, so 409 is the expected body answer;
			// what this test asserts is the *limiter*, which counts every attempt.
			let lastStatus = 0;
			for (let i = 0; i < 61; i += 1) {
				lastStatus = (
					await t.app.inject({
						method: "POST",
						url: `/api/conversations/${id}/messages`,
						headers: { ...me.headers, ...json },
						payload: { text: `hello ${i}` },
					})
				).statusCode;
			}
			expect(lastStatus).toBe(429);

			// a different session has its own window
			const other = t.mint({ id: "bob", role: "user" });
			const otherRes = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${id}/messages`,
				headers: { ...other.headers, ...json },
				payload: { text: "hi" },
			});
			expect(otherRes.statusCode).not.toBe(429);
		}, FAKE);
	});

	it("[11-security#4.6] allows 120 filesystem browses a minute, then answers 429", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			let lastStatus = 0;
			for (let i = 0; i < 121; i += 1) {
				lastStatus = (
					await t.app.inject({ method: "GET", url: "/api/fs/browse", headers: me.headers })
				).statusCode;
			}
			expect(lastStatus).toBe(429);
		});
	});
});
