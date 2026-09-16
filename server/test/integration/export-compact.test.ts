// spec/09-api.md §8 — GET /api/conversations/:id/export and POST /api/conversations/:id/compact.
import type { CompactResponse, UiEvent, UiMessage } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";

const json = { "content-type": "application/json" };
const FAKE = { env: { PIUI_FAKE_MODEL: "1" } };

async function newChat(t: TestApp, me: MintedPrincipal, title = "Exported chat"): Promise<string> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...me.headers, ...json },
		payload: { mode: "chat", provider: "piui-fake", modelId: "fake-1", title },
	});
	expect(res.statusCode).toBe(201);
	return res.json<{ conversation: { id: string } }>().conversation.id;
}

async function promptAndSettle(t: TestApp, me: MintedPrincipal, id: string, text: string) {
	const before = t.services.fakeModel!.turnsServed;
	const res = await t.app.inject({
		method: "POST",
		url: `/api/conversations/${id}/messages`,
		headers: { ...me.headers, ...json },
		payload: { text },
	});
	expect(res.statusCode).toBe(202);
	await waitUntil(
		() =>
			t.services.fakeModel!.turnsServed > before &&
			t.services.hub.peek(id)?.session.isStreaming === false,
		20_000,
	);
}

describe("export", () => {
	it("[09-api#8.1] exports json, markdown and html with tool cards and the command echo", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[{ toolCall: { name: "web_search", args: { query: "pi coding agent" } } }],
				[{ text: "Found it: **pi**.\n\n```js\nconsole.log(1)\n```" }],
			]);
			const id = await newChat(t, me);
			await promptAndSettle(t, me, id, "search for the pi coding agent");

			const asJson = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${id}/export?format=json`,
				headers: me.headers,
			});
			expect(asJson.statusCode).toBe(200);
			expect(asJson.headers["content-type"]).toContain("application/json");
			const body = asJson.json<{ conversation: { id: string }; messages: UiMessage[] }>();
			expect(body.conversation.id).toBe(id);
			expect(body.messages.some((m) => m.blocks.some((b) => b.type === "tool"))).toBe(true);

			const md = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${id}/export?format=md`,
				headers: me.headers,
			});
			expect(md.headers["content-type"]).toContain("text/markdown");
			expect(md.headers["content-disposition"]).toContain(".md");
			expect(md.payload).toContain("## User");
			expect(md.payload).toContain("search for the pi coding agent");
			// a tool call is a fenced block, not a silent gap
			expect(md.payload).toContain("```json");
			expect(md.payload).toContain("web_search");

			const html = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${id}/export?format=html`,
				headers: me.headers,
			});
			expect(html.headers["content-type"]).toContain("text/html");
			expect(html.payload).toContain("<!doctype html>");
			expect(html.payload).toContain("Exported chat");
			expect(html.payload).toContain("web_search");
			// self-contained: no external asset may be fetched by the exported file
			expect(html.payload).not.toMatch(/<script|src="http/);
		}, FAKE);
	});

	it("[09-api#8.2] escapes model output in the HTML export and refuses an unknown format", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([[{ text: "<img src=x onerror=alert(1)>" }]]);
			const id = await newChat(t, me, "Escaping");
			await promptAndSettle(t, me, id, "say something dangerous");

			const html = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${id}/export?format=html`,
				headers: me.headers,
			});
			expect(html.payload).toContain("&lt;img src=x onerror=alert(1)&gt;");
			expect(html.payload).not.toContain("<img src=x");

			const bad = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${id}/export?format=pdf`,
				headers: me.headers,
			});
			expect(bad.statusCode).toBe(400);
			expect(bad.json<{ error: { code: string } }>().error.code).toBe("validation_error");
		}, FAKE);
	});
});

describe("compaction", () => {
	it("[09-api#8.3] compacts on request, answers the summary and leaves a divider in the transcript", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			// Compaction only triggers above pi's keepRecentTokens (20 000 ≈ 80 KB of text), so the
			// script answers with big single-delta turns (spike plan/spikes/13 §2 fact 4).
			const long = (label: string) => `${label} `.repeat(30_000);
			t.services.fakeModel!.setScripts([
				[{ text: long("alpha"), chunk: 1_000_000 }],
				[{ text: long("beta"), chunk: 1_000_000 }],
				[{ text: long("gamma"), chunk: 1_000_000 }],
				[{ text: "Summary: the user asked three questions about greek letters." }],
			]);
			const id = await newChat(t, me, "Long chat");
			await promptAndSettle(t, me, id, "first");
			await promptAndSettle(t, me, id, "second");
			await promptAndSettle(t, me, id, "third");

			const stream = await t.openSse(`/api/conversations/${id}/events`, me);
			const res = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${id}/compact`,
				headers: { ...me.headers, ...json },
				payload: {},
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<CompactResponse>();
			expect(body.summary).toContain("greek letters");
			expect(body.tokensBefore).toBeGreaterThan(0);
			expect(body.estimatedTokensAfter).toBeGreaterThan(0);
			expect(typeof body.cost).toBe("number");

			// both SSE channels said something happened
			await stream.waitFor((frames) =>
				frames.some((f) => {
					const event = f.json<UiEvent>();
					return event.type === "notice" && /compact/i.test(event.text);
				}),
			);
			stream.stop();

			const messages = (
				await t.app.inject({
					method: "GET",
					url: `/api/conversations/${id}/messages`,
					headers: me.headers,
				})
			).json<{ messages: UiMessage[] }>().messages;
			// pi replaces the transcript with a compactionSummary message plus the kept tail.
			const system = messages.filter((m) => m.role === "system");
			expect(system.length).toBe(1);
			expect(system[0]!.blocks.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain(
				"greek letters",
			);
			expect(messages.length).toBeLessThan(6);
		}, FAKE);
	});

	it("[09-api#8.4] answers 409 when there is nothing to compact yet", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([[{ text: "short" }]]);
			const id = await newChat(t, me, "Short chat");
			await promptAndSettle(t, me, id, "hello");

			const res = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${id}/compact`,
				headers: { ...me.headers, ...json },
				payload: {},
			});
			expect(res.statusCode).toBe(409);
			const error = res.json<{ error: { code: string; message: string } }>().error;
			expect(error.code).toBe("conversation_busy");
			expect(error.message).toMatch(/too small|nothing to compact/i);
		}, FAKE);
	});
});
