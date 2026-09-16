// spec/16-extensions.md §§3-5 — an extension inside a real conversation: its tool, its
// command, its dialog bridge, and the fact that a throwing extension is survivable.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	CommandsResponse,
	ConversationDetail,
	CreateConversationResponse,
	ExtensionSummary,
	UiEvent,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import { GOOD_EXTENSION } from "../support/extensions.js";
import type { MintedPrincipal } from "../support/principal.js";
import { withWorkspace } from "../support/workspace.js";

const json = { "content-type": "application/json" };

/** Registers a tool that asks the user a question through pi's extension UI context. */
const ASKING_EXTENSION = `import { Type } from "typebox";

export default function (pi: any) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask",
		description: "Ask the user something.",
		parameters: Type.Object({ question: Type.String() }),
		async execute(_id: string, params: any, _s: any, _u: any, ctx: any) {
			const ok = await ctx.ui.confirm("Really?", params.question);
			ctx.ui.setStatus("asker", ok ? "confirmed" : "declined");
			return { content: [{ type: "text", text: "answer=" + ok }], details: {} };
		},
	});
	pi.registerCommand("ask", { description: "Ask something", handler: async () => {} });
}
`;

const THROWING_EXTENSION = `export default function (pi: any) {
	pi.on("message_end", () => { throw new Error("kaboom from the extension"); });
}
`;

async function plant(t: TestApp, name: string, source: string): Promise<void> {
	const dir = join(t.home, "user-pi", "agent", "extensions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.ts`), source);
	// listing is what registers + probes ambient files (spec §2.2)
	await t.services.extensions.list();
}

async function agent(
	t: TestApp,
	me: MintedPrincipal,
	wsPath: string,
	profileBody: Record<string, unknown> = {},
): Promise<ConversationDetail> {
	const fake = t.services.fakeModel!;
	const profile = await t.app.inject({
		method: "POST",
		url: "/api/profiles",
		headers: { ...me.headers, ...json },
		payload: {
			name: `P${Math.random().toString(36).slice(2, 8)}`,
			toolNames: ["ls"],
			...profileBody,
		},
	});
	expect(profile.statusCode).toBe(201);
	const existing = await t.app.inject({
		method: "GET",
		url: "/api/workspaces",
		headers: me.headers,
	});
	const known = existing
		.json<{ items: { id: string; path: string }[] }>()
		.items.find((item) => item.path === wsPath);
	const workspace = known
		? { json: () => known }
		: await t.app.inject({
				method: "POST",
				url: "/api/workspaces",
				headers: { ...me.headers, ...json },
				payload: { name: "ws", path: wsPath },
			});
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...me.headers, ...json },
		payload: {
			mode: "agent",
			provider: fake.providerId,
			modelId: fake.modelId,
			profileId: profile.json<{ id: string }>().id,
			workspaceId: workspace.json<{ id: string }>().id,
			title: "Ext",
		},
	});
	expect(res.statusCode).toBe(201);
	return res.json<CreateConversationResponse>().conversation;
}

const events = (frames: { json<T>(): T }[]): UiEvent[] => frames.map((f) => f.json<UiEvent>());

describe("extensions in a conversation", () => {
	it("[16-extensions#10.1] puts the extension command in the / menu of a new conversation", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					await plant(t, "deployer", GOOD_EXTENSION);
					const conversation = await agent(t, me, ws.path);
					const res = await t.app.inject({
						method: "GET",
						url: `/api/conversations/${conversation.id}/commands`,
						headers: me.headers,
					});
					const command = res.json<CommandsResponse>().items.find((item) => item.name === "deploy");
					expect(command).toMatchObject({
						source: "extension",
						display: "/deploy",
						availableWhileStreaming: true,
					});
				},
				{ env: { PIUI_FAKE_MODEL: "1" } },
			);
		});
	});

	it("[16-extensions#10.4] disables an extension for one profile only", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					await plant(t, "deployer", GOOD_EXTENSION);
					const extension = (await t.services.extensions.list()).items.find(
						(item: ExtensionSummary) => item.name === "deployer",
					)!;

					const withTool = await agent(t, me, ws.path);
					const without = await agent(t, me, ws.path, {
						disabledExtensionIds: [extension.id],
					});
					expect(withTool.tools.map((tool) => tool.name)).toContain("deploy");
					expect(without.tools.map((tool) => tool.name)).not.toContain("deploy");
					// …and the session really loaded it in one and not the other
					expect(t.services.profiles.resolve(withTool.profile!.id).extensionPaths).toHaveLength(1);
					expect(t.services.profiles.resolve(without.profile!.id).extensionPaths).toEqual([]);
				},
				{ env: { PIUI_FAKE_MODEL: "1" } },
			);
		});
	});

	it("[16-extensions#10.5] a globally disabled extension disappears from new conversations", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					await plant(t, "deployer", GOOD_EXTENSION);
					const extension = (await t.services.extensions.list()).items[0]!;
					const before = await agent(t, me, ws.path);
					expect(before.tools.map((tool) => tool.name)).toContain("deploy");

					const globalEvents = await t.openGlobalEvents(me);
					await t.services.extensions.patch(extension.id, { enabled: false });
					await globalEvents.waitFor((frames) =>
						frames.some((f) => f.json<{ type: string }>().type === "extensions_changed"),
					);
					globalEvents.stop();

					const after = await agent(t, me, ws.path);
					expect(after.tools.map((tool) => tool.name)).not.toContain("deploy");
					// the running conversation keeps its loaded extension (spec §7.3)
					expect(t.services.hub.peek(before.id)).toBeDefined();
				},
				{ env: { PIUI_FAKE_MODEL: "1" } },
			);
		});
	});

	it("[16-extensions#10.6] renders a dialog, resolves the extension promise, and survives a reconnect", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					await plant(t, "asker", ASKING_EXTENSION);
					t.services.fakeModel!.setScripts([
						[{ toolCall: { name: "ask_user", args: { question: "ship it?" } } }],
						[{ text: "done." }],
					]);
					const conversation = await agent(t, me, ws.path);
					const first = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
					await t.app.inject({
						method: "POST",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: { ...me.headers, ...json },
						payload: { text: "ask me" },
					});

					await first.waitFor((frames) =>
						events(frames).some((event) => event.type === "ui_request"),
					);
					const request = events(first.frames).find(
						(event): event is Extract<UiEvent, { type: "ui_request" }> =>
							event.type === "ui_request",
					)!;
					expect(request).toMatchObject({
						method: "confirm",
						title: "Really?",
						message: "ship it?",
					});

					// a second tab attaches mid-dialog and sees the pending request in its snapshot
					const second = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
					await second.waitFor((frames) =>
						events(frames).some((event) => event.type === "snapshot"),
					);
					const snapshot = events(second.frames).find(
						(event): event is Extract<UiEvent, { type: "snapshot" }> => event.type === "snapshot",
					)!;
					expect(snapshot.pendingUiRequests?.map((r) => r.requestId)).toEqual([request.requestId]);

					// answering from the second tab closes the first tab's modal
					const answer = await t.app.inject({
						method: "POST",
						url: `/api/conversations/${conversation.id}/ui-response`,
						headers: { ...me.headers, ...json },
						payload: { requestId: request.requestId, confirmed: true },
					});
					expect(answer.statusCode).toBe(200);
					await first.waitFor((frames) =>
						events(frames).some(
							(event) =>
								event.type === "ui_request_resolved" && event.requestId === request.requestId,
						),
					);
					// the extension's promise resolved: the tool finished with the answer
					await first.waitFor(
						(frames) => JSON.stringify(events(frames)).includes("answer=true"),
						20_000,
					);
					await first.waitFor((frames) => events(frames).some((event) => event.type === "status"));
					first.stop();
					second.stop();
				},
				{ env: { PIUI_FAKE_MODEL: "1" } },
			);
		});
	});

	it("[16-extensions#10.7] an extension that throws produces a notice and the conversation keeps working", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					await plant(t, "boomer", THROWING_EXTENSION);
					t.services.fakeModel!.setScripts([[{ text: "still here." }]]);
					const conversation = await agent(t, me, ws.path);
					const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
					await t.app.inject({
						method: "POST",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: { ...me.headers, ...json },
						payload: { text: "hello" },
					});
					await stream.waitFor(
						(frames) =>
							events(frames).some(
								(event) => event.type === "notice" && /boomer\.ts/.test(event.text),
							),
						20_000,
					);
					// the answer still arrived
					await waitUntil(
						() => JSON.stringify(events(stream.frames)).includes("still here."),
						20_000,
					);
					stream.stop();
				},
				{ env: { PIUI_FAKE_MODEL: "1" } },
			);
		});
	});
});
