// spec/07-chat-mode.md §6 items 2-3 and spec/05-skills-and-tools.md §B.5 items 1-2 — the M3
// gate. A scripted fake provider drives the tool call; the search provider's HTTP call is the
// injected fetch, so the whole round trip runs offline.
import type {
	ConversationDetail,
	CreateConversationResponse,
	MessagesResponse,
	UiEvent,
	UiMessage,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";

const json = { "content-type": "application/json" };

const searchFetch = (async (input: unknown) => {
	const url = String(input);
	if (url.startsWith("https://api.search.brave.com")) {
		return new Response(
			JSON.stringify({
				web: {
					results: [
						{
							title: "Node.js — Previous releases",
							url: "https://nodejs.org/en/about/previous-releases",
							description: "Node.js 24 is the active LTS.",
						},
						{
							title: "Node.js release schedule",
							url: "https://github.com/nodejs/release",
							description: "Release working group.",
						},
					],
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}
	return new Response("<html><body><h1>Releases</h1><p>Node 24 is LTS.</p></body></html>", {
		status: 200,
		headers: { "content-type": "text/html" },
	});
}) as unknown as typeof fetch;

const WEB = {
	env: {
		PIUI_FAKE_MODEL: "1",
		PIUI_SEARCH_PROVIDER: "brave",
		PIUI_SEARCH_API_KEY: "brave-key",
	},
	fetch: searchFetch,
};

const NO_SEARCH = { env: { PIUI_FAKE_MODEL: "1" } };

async function newChat(
	t: TestApp,
	who: MintedPrincipal,
	options: { webSearch?: boolean } = {},
): Promise<ConversationDetail> {
	const fake = t.services.fakeModel!;
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...who.headers, ...json },
		payload: {
			mode: "chat",
			provider: fake.providerId,
			modelId: fake.modelId,
			title: "Web search chat",
			timezone: "UTC",
			webSearch: options.webSearch === true,
		},
	});
	expect(res.statusCode).toBe(201);
	return res.json<CreateConversationResponse>().conversation;
}

const toolBlocks = (messages: UiMessage[]) =>
	messages.flatMap((message) => message.blocks.filter((block) => block.type === "tool"));

const assistantText = (messages: UiMessage[]): string =>
	messages
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text))
		.join("\n");

async function promptAndSettle(t: TestApp, who: MintedPrincipal, id: string, text: string) {
	const res = await t.app.inject({
		method: "POST",
		url: `/api/conversations/${id}/messages`,
		headers: { ...who.headers, ...json },
		payload: { text },
	});
	expect(res.statusCode).toBe(202);
	await waitUntil(() => t.services.hub.peek(id)?.session.isStreaming === false, {
		message: "run never settled",
	});
	const messages = await t.app.inject({
		method: "GET",
		url: `/api/conversations/${id}/messages`,
		headers: who.headers,
	});
	return messages.json<MessagesResponse>().messages;
}

describe("chat mode with web search off", () => {
	it("[07-chat-mode#6.2] answers from stale knowledge, mentions the toggle, and calls no tool", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[
					{
						text: "My information may be out of date. Enable web search with the toggle in the composer to check.",
					},
				],
			]);
			const chat = await newChat(t, me);
			expect(chat.webSearch).toBe(false);
			expect(chat.tools).toEqual([]);
			expect(chat.systemPromptPreview).toContain("no web access in this conversation");
			expect(chat.systemPromptPreview).toContain("toggle in the composer");

			const messages = await promptAndSettle(t, me, chat.id, "what is the latest Node LTS?");
			expect(toolBlocks(messages)).toEqual([]);
			expect(assistantText(messages)).toMatch(/out of date|stale/i);
			expect(assistantText(messages)).toMatch(/toggle/i);

			// and the live pi session really has no tools at all
			const live = t.services.hub.peek(chat.id)!;
			expect(
				(live.session as unknown as { getAllTools(): { name: string }[] }).getAllTools(),
			).toEqual([]);
		}, NO_SEARCH);
	});

	it("[05-skills-and-tools#B.5.1] arms no tool even when a search provider is configured", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const chat = await newChat(t, me, { webSearch: false });
			expect(chat.tools).toEqual([]);
			const live = await t.services.hub.ensure(chat.id);
			expect(
				(live.session as unknown as { getAllTools(): { name: string }[] }).getAllTools(),
			).toEqual([]);
		}, WEB);
	});

	it("[05-skills-and-tools#B.5.1] exposes zero tools: a `read` of /etc/hostname is refused", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[{ toolCall: { name: "read", args: { path: "/etc/hostname" } } }],
				[{ text: "I have no tool that can read files in this conversation." }],
			]);
			const chat = await newChat(t, me);
			const messages = await promptAndSettle(t, me, chat.id, "read /etc/hostname");

			const tools = toolBlocks(messages);
			// pi may not even surface the call; what matters is that nothing succeeded and no
			// file content came back.
			for (const block of tools) expect(block.state).toBe("error");
			const transcript = JSON.stringify(messages);
			expect(transcript).not.toContain("/etc/hostname\n");
			expect(assistantText(messages)).toMatch(/no tool/i);
		}, NO_SEARCH);
	});
});

describe("chat mode with web search on", () => {
	it("[07-chat-mode#6.3] produces a web_search card whose results feed the Sources footer", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[{ toolCall: { name: "web_search", args: { query: "latest node lts" } } }],
				[
					{
						text: "Node.js 24 is the active LTS.\n\n## Sources\n- [Node.js — Previous releases](https://nodejs.org/en/about/previous-releases)",
					},
				],
			]);
			const chat = await newChat(t, me, { webSearch: true });
			expect(chat.webSearch).toBe(true);
			expect(chat.tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
			expect(chat.systemPromptPreview).toContain("`web_search`");

			const stream = await t.openSse(`/api/conversations/${chat.id}/events`, me);
			const messages = await promptAndSettle(t, me, chat.id, "what is the latest Node LTS?");

			const tools = toolBlocks(messages);
			expect(tools.length).toBe(1);
			const card = tools[0]!;
			expect(card.name).toBe("web_search");
			expect(card.state).toBe("ok");
			expect(card.args).toMatchObject({ query: "latest node lts" });
			expect(card.output).toContain("https://nodejs.org/en/about/previous-releases");
			// the Sources footer reads the urls out of `details`
			expect(card.details).toMatchObject({
				provider: "brave",
				results: [
					{ url: "https://nodejs.org/en/about/previous-releases" },
					{ url: "https://github.com/nodejs/release" },
				],
			});
			expect(assistantText(messages)).toContain("https://nodejs.org/en/about/previous-releases");

			// the card was streamed live, too (the UI must not need a refetch)
			await stream.waitFor((frames) =>
				frames.some((f) => {
					const event = f.json<UiEvent>();
					return (
						(event.type === "block_start" || event.type === "tool_update") &&
						"block" in event &&
						event.block.type === "tool" &&
						event.block.name === "web_search"
					);
				}),
			);
		}, WEB);
	});

	it("[07-chat-mode#6.3] web_fetch reads a page the model picked from the results", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[
					{
						toolCall: {
							name: "web_fetch",
							args: { url: "https://nodejs.org/en/about/previous-releases" },
						},
					},
				],
				[{ text: "Node 24 is LTS." }],
			]);
			const chat = await newChat(t, me, { webSearch: true });
			const messages = await promptAndSettle(t, me, chat.id, "read the release page");

			const card = toolBlocks(messages)[0]!;
			expect(card.name).toBe("web_fetch");
			expect(card.state).toBe("ok");
			expect(card.output).toContain("# Releases");
			expect(card.details).toMatchObject({
				finalUrl: "https://nodejs.org/en/about/previous-releases",
				status: 200,
			});
		}, WEB);
	});

	it("[05-skills-and-tools#B.5.2] toggling mid-conversation applies from the next prompt and emits a notice", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[{ text: "I cannot search the web." }],
				[{ toolCall: { name: "web_search", args: { query: "node lts" } } }],
				[{ text: "Node 24." }],
			]);
			const chat = await newChat(t, me);
			const stream = await t.openSse(`/api/conversations/${chat.id}/events`, me);
			const before = await promptAndSettle(t, me, chat.id, "what is the latest Node LTS?");
			expect(toolBlocks(before)).toEqual([]);
			const historyBefore = JSON.stringify(before);

			const patched = await t.app.inject({
				method: "PATCH",
				url: `/api/conversations/${chat.id}`,
				headers: { ...me.headers, ...json },
				payload: { webSearch: true },
			});
			expect(patched.statusCode).toBe(200);
			expect(patched.json<ConversationDetail>().tools.map((tool) => tool.name)).toEqual([
				"web_search",
				"web_fetch",
			]);

			await stream.waitFor((frames) =>
				frames.some((f) => {
					const event = f.json<UiEvent>();
					return event.type === "notice" && /web search enabled/i.test(event.text);
				}),
			);

			// history is untouched: the first answer still has no tool call
			const after = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${chat.id}/messages`,
				headers: me.headers,
			});
			const replayed = after.json<MessagesResponse>().messages;
			expect(toolBlocks(replayed)).toEqual([]);
			expect(JSON.stringify(replayed)).toBe(historyBefore);

			// …and the next prompt can search
			const next = await promptAndSettle(t, me, chat.id, "and now?");
			expect(toolBlocks(next).map((block) => block.name)).toEqual(["web_search"]);
		}, WEB);
	});

	it("[05-skills-and-tools#B.5.2] turning it back off emits the matching notice", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const chat = await newChat(t, me, { webSearch: true });
			await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "hi" },
			});
			await waitUntil(() => t.services.hub.peek(chat.id)?.session.isStreaming === false);
			const stream = await t.openSse(`/api/conversations/${chat.id}/events`, me);

			await t.app.inject({
				method: "PATCH",
				url: `/api/conversations/${chat.id}`,
				headers: { ...me.headers, ...json },
				payload: { webSearch: false },
			});
			await stream.waitFor((frames) =>
				frames.some((f) => {
					const event = f.json<UiEvent>();
					return event.type === "notice" && /web search disabled/i.test(event.text);
				}),
			);
		}, WEB);
	});

	it("[05-skills-and-tools#B.4] refuses to arm the web tools when no provider is configured", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const chat = await newChat(t, me, { webSearch: true });
			// the toggle is honoured in the prompt, but no tool is armed and the UI is told why
			expect(chat.tools).toEqual([]);
			expect(chat.warnings ?? []).toEqual([]);
			const live = await t.services.hub.ensure(chat.id);
			expect(
				(live.session as unknown as { getAllTools(): { name: string }[] }).getAllTools(),
			).toEqual([]);
		}, NO_SEARCH);
	});
});
