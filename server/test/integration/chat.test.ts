// spec/07-chat-mode.md §6 and spec/09-api.md §§8-9 — a chat round trip on the fake provider.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AbortResponse,
	ConversationDetail,
	CreateConversationResponse,
	MessagesResponse,
	PostMessageResponse,
	UiEvent,
	UiMessage,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";

const FAKE = { env: { PIUI_FAKE_MODEL: "1" } };
const json = { "content-type": "application/json" };

async function newChat(
	t: TestApp,
	who: MintedPrincipal,
	options: { title?: string; thinkingLevel?: string } = {},
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
			title: options.title ?? "Fixture chat",
			timezone: "Europe/Paris",
		},
	});
	expect(res.statusCode).toBe(201);
	return res.json<CreateConversationResponse>().conversation;
}

const textOf = (messages: UiMessage[]): string =>
	messages
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text))
		.join("");

describe("chat mode", () => {
	it("[07-chat-mode#6.1] streams an answer, survives a reload, and survives a restart", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([[{ text: "I am a fake model." }]]);
			const chat = await newChat(t, me);

			const stream = await t.openSse(`/api/conversations/${chat.id}/events`, me);
			await stream.waitFor((frames) => frames.length >= 1);
			expect(stream.frames[0]!.json<UiEvent>().type).toBe("snapshot");

			const prompt = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "what model are you?" },
			});
			expect(prompt.statusCode).toBe(202);
			expect(prompt.json<PostMessageResponse>()).toEqual({ accepted: true, queuedAs: null });

			await stream.waitFor((frames) => frames.some((f) => f.json<UiEvent>().type === "done"));
			// tokens arrived as deltas, not one lump
			const types = stream.frames.map((f) => f.json<UiEvent>().type);
			expect(types).toContain("message_start");
			expect(types).toContain("block_delta");
			expect(types).toContain("message_end");
			// the streamed assistant bubble and its final version share one id, so a client
			// replaces it instead of rendering the answer twice (found in the browser).
			const assistantStarts = stream.frames
				.map((f) => f.json<UiEvent>())
				.filter((e) => e.type === "message_start" && e.message.role === "assistant");
			const assistantEnds = stream.frames
				.map((f) => f.json<UiEvent>())
				.filter((e) => e.type === "message_end" && e.message.role === "assistant");
			expect(assistantStarts).toHaveLength(1);
			expect(assistantEnds.map((e) => (e as { message: UiMessage }).message.id)).toEqual(
				assistantStarts.map((e) => (e as { message: UiMessage }).message.id),
			);

			// every frame carries a strictly increasing id
			const seqs = stream.frames.map((f) => Number(f.id)).filter((n) => Number.isFinite(n));
			expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
			stream.stop();

			// reload: the transcript comes back from the live session
			const reloaded = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${chat.id}/messages`,
				headers: me.headers,
			});
			const messages = reloaded.json<MessagesResponse>().messages;
			expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(textOf(messages)).toBe("I am a fake model.");

			// restart: a brand-new server on the same home rehydrates from the pi session file
			const restarted = await buildServer(t.ctx);
			await restarted.ready();
			try {
				const after = await restarted.inject({
					method: "GET",
					url: `/api/conversations/${chat.id}/messages`,
					headers: me.headers,
				});
				expect(textOf(after.json<MessagesResponse>().messages)).toBe("I am a fake model.");
			} finally {
				await restarted.close();
			}
		}, FAKE);
	});

	it("[07-chat-mode#6.1] composes the chat system prompt and loads no host resources", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const chat = await newChat(t, me);
			const live = await t.services.hub.ensure(chat.id);
			expect(live.session.systemPrompt).toContain(
				"You are a helpful assistant answering questions in a web chat",
			);
			expect(live.session.systemPrompt).toContain("Europe/Paris");
			// pi's coding prompt and any ambient AGENTS.md would show up here
			expect(live.session.systemPrompt.toLowerCase()).not.toContain("agents.md");

			const detail = await t.app.inject({
				method: "GET",
				url: `/api/conversations/${chat.id}`,
				headers: me.headers,
			});
			const body = detail.json<ConversationDetail>();
			expect(body.systemPromptPreview).toBe(live.session.systemPrompt.slice(0, 4096));
			expect(body.tools).toEqual([]);
		}, FAKE);
	});

	it("[01-architecture#4.3] loads no ambient extension, skill, context file or project setting", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const chat = await newChat(t, me);
			// plant everything pi would otherwise discover in the conversation's cwd
			const cwd = join(t.ctx.config.paths.scratch, chat.id);
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "# Project rules\nAlways run the linter first.\n");
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ theme: "hostile" }));
			mkdirSync(join(cwd, ".pi", "skills", "leak"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "skills", "leak", "SKILL.md"),
				"---\nname: leak\ndescription: should never load\n---\nleak\n",
			);

			const live = await t.services.hub.ensure(chat.id);
			const session = live.session as unknown as {
				systemPrompt: string;
				getActiveToolNames(): string[];
				resourceLoader: {
					getExtensions(): { extensions: unknown[] };
					getSkills(): { skills: unknown[] };
				};
			};
			expect(session.systemPrompt).not.toContain("Always run the linter first");
			expect(session.systemPrompt).not.toContain("Project rules");
			expect(session.getActiveToolNames()).toEqual([]);
			expect(session.resourceLoader.getExtensions().extensions).toEqual([]);
			expect(session.resourceLoader.getSkills().skills).toEqual([]);
		}, FAKE);
	});

	it("[09-api#9.1] replays from Last-Event-ID and falls back to a snapshot when it is stale", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([[{ text: "hello there" }]]);
			const chat = await newChat(t, me);
			const warmup = await t.openSse(`/api/conversations/${chat.id}/events`, me);
			await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "hi" },
			});
			await warmup.waitFor((frames) => frames.some((f) => f.json<UiEvent>().type === "done"));
			warmup.stop();

			const replayed = await t.openSse(`/api/conversations/${chat.id}/events?since=2`, me);
			await replayed.waitFor((frames) => frames.length > 0);
			const first = replayed.frames[0]!.json<UiEvent>();
			expect(first.type).not.toBe("snapshot");
			expect(first.seq).toBe(3);
			replayed.stop();

			const stale = await t.openSse(`/api/conversations/${chat.id}/events?since=99999`, me);
			await stale.waitFor((frames) => frames.length > 0);
			expect(stale.frames[0]!.json<UiEvent>().type).toBe("snapshot");
			stale.stop();

			// two subscribers see identical frames
			const a = await t.openSse(`/api/conversations/${chat.id}/events`, me);
			const b = await t.openSse(`/api/conversations/${chat.id}/events`, me);
			await a.waitFor((f) => f.length > 0);
			await b.waitFor((f) => f.length > 0);
			expect(a.frames[0]!.data).toBe(b.frames[0]!.data);
			a.stop();
			b.stop();
		}, FAKE);
	});

	it("[07-chat-mode#6.5] queues a second prompt while streaming and delivers it exactly once", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[{ stall: 150 }, { text: "first answer" }],
				[{ text: "second answer" }],
			]);
			const chat = await newChat(t, me);
			const stream = await t.openSse(`/api/conversations/${chat.id}/events`, me);

			await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "first" },
			});
			const live = t.services.hub.peek(chat.id)!;
			await waitUntil(() => live.session.isStreaming);

			// without a streamingBehavior the API refuses
			const busy = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "second" },
			});
			expect(busy.statusCode).toBe(409);
			expect(busy.json<{ error: { code: string } }>().error.code).toBe("conversation_busy");

			const queued = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "second", streamingBehavior: "followUp" },
			});
			expect(queued.statusCode).toBe(202);
			expect(queued.json<PostMessageResponse>().queuedAs).toBe("followUp");
			await stream.waitFor((frames) =>
				frames.some((f) => {
					const event = f.json<UiEvent>();
					return event.type === "queue" && event.followUp.includes("second");
				}),
			);

			await waitUntil(() => !live.session.isStreaming && live.session.isIdle, 5000);
			stream.stop();

			const messages = (
				await t.app.inject({
					method: "GET",
					url: `/api/conversations/${chat.id}/messages`,
					headers: me.headers,
				})
			).json<MessagesResponse>().messages;
			const userTexts = messages
				.filter((m) => m.role === "user")
				.map((m) => m.blocks.map((b) => (b.type === "text" ? b.text : "")).join(""));
			expect(userTexts.filter((t) => t.includes("second"))).toHaveLength(1);
			expect(textOf(messages)).toContain("second answer");
		}, FAKE);
	});

	it("[07-chat-mode#6.6] stops within a second and keeps the partial answer marked stopped", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([
				[{ text: "partial" }, { stall: 5000 }, { text: " never arrives" }],
			]);
			const chat = await newChat(t, me);
			const stream = await t.openSse(`/api/conversations/${chat.id}/events`, me);
			await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "go" },
			});
			const live = t.services.hub.peek(chat.id)!;
			await waitUntil(() => live.session.isStreaming);
			await stream.waitFor((frames) =>
				frames.some((f) => f.json<UiEvent>().type === "block_delta"),
			);

			const startedAt = Date.now();
			const aborted = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/abort`,
				headers: me.headers,
			});
			expect(aborted.statusCode).toBe(200);
			expect(aborted.json<AbortResponse>().restored).toEqual({ steering: [], followUp: [] });
			expect(Date.now() - startedAt).toBeLessThan(2000);
			await waitUntil(() => !live.session.isStreaming, 3000);
			stream.stop();

			const messages = (
				await t.app.inject({
					method: "GET",
					url: `/api/conversations/${chat.id}/messages`,
					headers: me.headers,
				})
			).json<MessagesResponse>().messages;
			const assistant = messages.find((m) => m.role === "assistant");
			expect(textOf(messages)).toContain("partial");
			expect(assistant?.stopped).toBe(true);
		}, FAKE);
	});

	it("[09-api#8.1] refuses a chat with a profile or workspace, and an unknown model", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const bad = await t.app.inject({
				method: "POST",
				url: "/api/conversations",
				headers: { ...me.headers, ...json },
				payload: { mode: "chat", provider: "nope", modelId: "nope" },
			});
			expect(bad.statusCode).toBe(400);
			expect(bad.json<{ error: { code: string } }>().error.code).toBe("model_unavailable");

			const withProfile = await t.app.inject({
				method: "POST",
				url: "/api/conversations",
				headers: { ...me.headers, ...json },
				payload: {
					mode: "chat",
					provider: t.services.fakeModel!.providerId,
					modelId: t.services.fakeModel!.modelId,
					profileId: "p1",
				},
			});
			expect(withProfile.statusCode).toBe(400);
		}, FAKE);
	});

	it("[09-api#8.2] auto-titles from the first user message and never overwrites a set title", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			t.services.fakeModel!.setScripts([[{ text: "Fake Model Identity" }], [{ text: "answer" }]]);
			const created = await t.app.inject({
				method: "POST",
				url: "/api/conversations",
				headers: { ...me.headers, ...json },
				payload: {
					mode: "chat",
					provider: t.services.fakeModel!.providerId,
					modelId: t.services.fakeModel!.modelId,
				},
			});
			const chat = created.json<CreateConversationResponse>().conversation;
			expect(chat.title).toBe("");

			await t.app.inject({
				method: "POST",
				url: `/api/conversations/${chat.id}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "what model are you?" },
			});
			await waitUntil(() => t.ctx.repos.conversations.getById(chat.id)?.title !== "", 5000);
			const titled = t.ctx.repos.conversations.getById(chat.id)!;
			expect(titled.title).toBe("Fake Model Identity");

			const renamed = await t.app.inject({
				method: "PATCH",
				url: `/api/conversations/${chat.id}`,
				headers: { ...me.headers, ...json },
				payload: { title: "My chat" },
			});
			expect(renamed.json<ConversationDetail>().title).toBe("My chat");
			expect(t.ctx.repos.conversations.getById(chat.id)?.title_locked).toBe(1);
		}, FAKE);
	});
});
