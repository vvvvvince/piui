// spec/08-agent-mode.md §§1-6 and spec/03-profiles.md §8 — agent conversations running pi's
// real built-in tools inside a temp workspace (spike plan/spikes/09).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ApiErrorBody,
	ConversationDetail,
	CreateConversationResponse,
	MessagesResponse,
	ProfileDetail,
	SkillSummary,
	UiEvent,
	UiMessage,
	Workspace,
	WorkspaceTreeResponse,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";
import { withWorkspace } from "../support/workspace.js";

const FAKE = { env: { PIUI_FAKE_MODEL: "1" } };
const json = { "content-type": "application/json" };

async function makeProfile(
	t: TestApp,
	who: MintedPrincipal,
	body: Record<string, unknown>,
): Promise<ProfileDetail> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/profiles",
		headers: { ...who.headers, ...json },
		payload: body,
	});
	expect(res.statusCode).toBe(201);
	return res.json<ProfileDetail>();
}

async function makeWorkspace(
	t: TestApp,
	who: MintedPrincipal,
	path: string,
	name = "ws",
): Promise<Workspace> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/workspaces",
		headers: { ...who.headers, ...json },
		payload: { name, path },
	});
	expect(res.statusCode).toBe(201);
	return res.json<Workspace>();
}

async function newAgent(
	t: TestApp,
	who: MintedPrincipal,
	options: { profileId: string; workspaceId: string; title?: string },
): Promise<{ conversation: ConversationDetail; warnings: string[] }> {
	const fake = t.services.fakeModel!;
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...who.headers, ...json },
		payload: {
			mode: "agent",
			provider: fake.providerId,
			modelId: fake.modelId,
			profileId: options.profileId,
			workspaceId: options.workspaceId,
			title: options.title ?? "Agent run",
		},
	});
	expect(res.statusCode).toBe(201);
	return res.json<CreateConversationResponse>();
}

const prompt = (t: TestApp, who: MintedPrincipal, id: string, text: string, behavior?: string) =>
	t.app.inject({
		method: "POST",
		url: `/api/conversations/${id}/messages`,
		headers: { ...who.headers, ...json },
		payload: { text, ...(behavior ? { streamingBehavior: behavior } : {}) },
	});

const toolBlocks = (messages: UiMessage[]) =>
	messages.flatMap((m) => m.blocks.filter((b) => b.type === "tool"));

describe("agent mode", () => {
	it("[08-agent-mode#8.1] writes a file and runs it, streaming bash output, and the tree shows it", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[
						{
							toolCall: {
								name: "write",
								args: { path: "hello.js", content: "console.log('hello world')\n" },
							},
						},
					],
					[{ toolCall: { name: "bash", args: { command: "node hello.js" } } }],
					[{ text: "Created hello.js and ran it." }],
				]);
				const profile = await makeProfile(t, me, {
					name: "Coding",
					toolNames: ["read", "write", "edit", "bash", "ls"],
				});
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				expect(conversation.mode).toBe("agent");
				expect(conversation.workspace?.path).toBe(workspace.path);
				expect(conversation.profile?.name).toBe("Coding");

				const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await prompt(t, me, conversation.id, "create a hello-world Node script and run it");
				await stream.waitFor(
					(frames) => frames.some((f) => f.json<UiEvent>().type === "done"),
					20_000,
				);

				const messages = (
					await t.app.inject({
						method: "GET",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: me.headers,
					})
				).json<MessagesResponse>().messages;
				const tools = toolBlocks(messages);
				expect(tools.map((b) => b.name)).toEqual(["write", "bash"]);
				expect(tools.every((b) => b.state === "ok")).toBe(true);
				expect(tools[1]!.output).toContain("hello world");

				// the streaming bash card got at least one live update before the result
				const updates = stream.frames
					.map((f) => f.json<UiEvent>())
					.filter((e) => e.type === "tool_update");
				expect(updates.length).toBeGreaterThan(0);
				stream.stop();

				expect(readFileSync(join(ws.path, "hello.js"), "utf8")).toContain("hello world");
				const tree = await t.app.inject({
					method: "GET",
					url: `/api/workspaces/${workspace.id}/tree`,
					headers: me.headers,
				});
				expect(tree.json<WorkspaceTreeResponse>().entries.map((e) => e.name)).toContain("hello.js");
			}, FAKE);
		});
	});

	it("[08-agent-mode#8.2] delivers a steering message once, after the current tool batch", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[{ stall: 200 }, { toolCall: { name: "ls", args: {} } }],
					[{ text: "first done" }],
					[{ text: "steered" }],
				]);
				const profile = await makeProfile(t, me, { name: "Lister", toolNames: ["ls"] });
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await prompt(t, me, conversation.id, "list the files");
				await waitUntil(() => t.services.hub.peek(conversation.id)?.session.isStreaming === true);

				const steer = await prompt(t, me, conversation.id, "also add a test", "steer");
				expect(steer.statusCode).toBe(202);
				expect(steer.json<{ queuedAs: string }>().queuedAs).toBe("steer");

				await stream.waitFor(
					(frames) => frames.filter((f) => f.json<UiEvent>().type === "done").length >= 1,
					20_000,
				);
				await waitUntil(
					() => t.services.hub.peek(conversation.id)?.session.isStreaming === false,
					20_000,
				);

				const messages = (
					await t.app.inject({
						method: "GET",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: me.headers,
					})
				).json<MessagesResponse>().messages;
				const userTexts = messages
					.filter((m) => m.role === "user")
					.map((m) => m.blocks.map((b) => (b.type === "text" ? b.text : "")).join(""));
				// delivered exactly once, and after the tool call that was already running
				expect(userTexts.filter((text) => text.includes("also add a test"))).toHaveLength(1);
				expect(userTexts[0]).toContain("list the files");
				// the chip is gone once consumed
				expect(t.services.hub.peek(conversation.id)!.state.queued).toEqual({
					steering: 0,
					followUp: 0,
				});
				stream.stop();
			}, FAKE);
		});
	});

	it("[08-agent-mode#8.3] stops a long bash command and marks the message stopped", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[{ toolCall: { name: "bash", args: { command: "sleep 30" } } }],
					[{ text: "unreachable" }],
				]);
				const profile = await makeProfile(t, me, { name: "Shell", toolNames: ["bash"] });
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await prompt(t, me, conversation.id, "run something slow");
				await waitUntil(
					() =>
						stream.frames.some((f) => {
							const event = f.json<UiEvent>();
							return event.type === "tool_update" && event.block.state === "running";
						}),
					20_000,
				);

				const abort = await t.app.inject({
					method: "POST",
					url: `/api/conversations/${conversation.id}/abort`,
					headers: me.headers,
				});
				expect(abort.statusCode).toBe(200);
				await waitUntil(
					() => t.services.hub.peek(conversation.id)?.session.isStreaming === false,
					20_000,
				);

				const messages = (
					await t.app.inject({
						method: "GET",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: me.headers,
					})
				).json<MessagesResponse>().messages;
				// the aborted turn is "stopped", not a red error the user did not cause
				expect(messages.some((m) => m.role === "error")).toBe(false);
				expect(messages.filter((m) => m.role === "assistant").some((m) => m.stopped === true)).toBe(
					true,
				);
				const bash = toolBlocks(messages).find((b) => b.name === "bash")!;
				expect(bash.state).toBe("error");
				expect(bash.output).toMatch(/abort/i);
				// and the sleep really is gone, not orphaned
				expect(existsSync(join(ws.path, "hello.js"))).toBe(false);
				stream.stop();
			}, FAKE);
		});
	});

	it("[08-agent-mode#8.4] a read-only profile cannot write: the model is handed exactly two tools", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[{ toolCall: { name: "write", args: { path: "nope.txt", content: "x" } } }],
					[{ text: "I do not have a write tool." }],
				]);
				const profile = await makeProfile(t, me, {
					name: "Reviewer",
					toolNames: ["read", "grep"],
				});
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				expect(conversation.tools.map((tool) => tool.name)).toEqual(["read", "grep"]);

				const live = await t.services.hub.ensure(conversation.id);
				const session = live.session as unknown as { getActiveToolNames(): string[] };
				expect(session.getActiveToolNames().sort()).toEqual(["grep", "read"]);

				const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await prompt(t, me, conversation.id, "write nope.txt");
				await stream.waitFor(
					(frames) => frames.some((f) => f.json<UiEvent>().type === "done"),
					20_000,
				);
				expect(existsSync(join(ws.path, "nope.txt"))).toBe(false);
				stream.stop();
			}, FAKE);
		});
	});

	it("[08-agent-mode#8.5] a client that reattaches mid-run gets one snapshot and no duplicates", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[{ stall: 200 }, { text: "a long answer produced while nobody was watching" }],
				]);
				const profile = await makeProfile(t, me, { name: "Quiet", toolNames: ["ls"] });
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				const first = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await prompt(t, me, conversation.id, "think out loud");
				await waitUntil(() => t.services.hub.peek(conversation.id)?.session.isStreaming === true);
				first.stop(); // the browser died

				await waitUntil(
					() => t.services.hub.peek(conversation.id)?.session.isStreaming === false,
					20_000,
				);
				const later = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await later.waitFor((frames) => frames.length >= 1);
				const snapshot = later.frames[0]!.json<UiEvent>();
				expect(snapshot.type).toBe("snapshot");
				if (snapshot.type !== "snapshot") throw new Error("unreachable");
				const assistantIds = snapshot.messages
					.filter((m) => m.role === "assistant")
					.map((m) => m.id);
				expect(new Set(assistantIds).size).toBe(assistantIds.length);
				expect(
					snapshot.messages
						.filter((m) => m.role === "assistant")
						.flatMap((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text))
						.join(""),
				).toBe("a long answer produced while nobody was watching");
				later.stop();
			}, FAKE);
		});
	});

	it("[08-agent-mode#8.6] rebuilds the whole transcript from the pi session file after a restart", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[{ toolCall: { name: "ls", args: {} } }],
					[{ text: "these are the files" }],
				]);
				const profile = await makeProfile(t, me, { name: "Lister", toolNames: ["ls"] });
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await prompt(t, me, conversation.id, "what is here?");
				await stream.waitFor(
					(frames) => frames.some((f) => f.json<UiEvent>().type === "done"),
					20_000,
				);
				stream.stop();

				const restarted = await buildServer(t.ctx);
				await restarted.ready();
				try {
					const after = await restarted.inject({
						method: "GET",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: me.headers,
					});
					const messages = after.json<MessagesResponse>().messages;
					expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
					expect(toolBlocks(messages).map((b) => b.name)).toEqual(["ls"]);
					expect(toolBlocks(messages)[0]!.output).toContain("README.md");
				} finally {
					await restarted.close();
				}
			}, FAKE);
		});
	});

	it("[08-agent-mode#8.7] answers 409 workspace_missing, never a 500, when the folder is gone", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				const profile = await makeProfile(t, me, { name: "Coder", toolNames: ["read"] });
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				renameSync(ws.path, `${ws.path}-moved`);
				try {
					const res = await prompt(t, me, conversation.id, "read the readme");
					expect(res.statusCode).toBe(409);
					expect(res.json<ApiErrorBody>().error.code).toBe("workspace_missing");
					expect(res.json<ApiErrorBody>().error.message).toMatch(/missing|moved|renamed/i);

					// the conversation itself still loads, so the user can fix the workspace
					const detail = await t.app.inject({
						method: "GET",
						url: `/api/conversations/${conversation.id}`,
						headers: me.headers,
					});
					expect(detail.statusCode).toBe(200);
				} finally {
					renameSync(`${ws.path}-moved`, ws.path);
				}
			}, FAKE);
		});
	});

	it("requires a profile and a workspace, and freezes both once the session exists", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				const fake = t.services.fakeModel!;
				const profile = await makeProfile(t, me, { name: "Coder", toolNames: ["read"] });
				const workspace = await makeWorkspace(t, me, ws.path);

				const missing = await t.app.inject({
					method: "POST",
					url: "/api/conversations",
					headers: { ...me.headers, ...json },
					payload: { mode: "agent", provider: fake.providerId, modelId: fake.modelId },
				});
				expect(missing.statusCode).toBe(400);
				expect(missing.json<ApiErrorBody>().error.code).toBe("validation_error");

				const unknownProfile = await t.app.inject({
					method: "POST",
					url: "/api/conversations",
					headers: { ...me.headers, ...json },
					payload: {
						mode: "agent",
						provider: fake.providerId,
						modelId: fake.modelId,
						profileId: "nope",
						workspaceId: workspace.id,
					},
				});
				expect(unknownProfile.statusCode).toBe(404);
				expect(unknownProfile.json<ApiErrorBody>().error.code).toBe("profile_not_found");

				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				const other = await makeProfile(t, me, { name: "Other", toolNames: ["ls"] });
				const patched = await t.app.inject({
					method: "PATCH",
					url: `/api/conversations/${conversation.id}`,
					headers: { ...me.headers, ...json },
					payload: { profileId: other.id },
				});
				expect(patched.statusCode).toBe(409);
				expect(patched.json<ApiErrorBody>().error.code).toBe("immutable_after_start");
			}, FAKE);
		});
	});
});

describe("profiles drive the agent", () => {
	it("[03-profiles#8.1] injects AGENTS.md and hands the model only the profile's tools", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[{ toolCall: { name: "ls", args: {} } }],
					[{ text: "Voilà." }],
				]);
				const profile = await makeProfile(t, me, {
					name: "Français",
					agentsMd: "Always answer in French.",
					toolNames: ["read", "ls"],
				});
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				expect(conversation.tools.map((tool) => tool.name)).toEqual(["read", "ls"]);
				// pi's own system prompt is preserved and AGENTS.md is appended (spike plan/spikes/09)
				expect(conversation.systemPromptPreview).toContain("Always answer in French.");
				expect(conversation.systemPromptPreview).toContain("Available tools:");
				expect(conversation.systemPromptPreview).not.toContain("bash:");

				const live = await t.services.hub.ensure(conversation.id);
				expect(
					(live.session as unknown as { getActiveToolNames(): string[] }).getActiveToolNames(),
				).not.toContain("bash");
			}, FAKE);
		});
	});

	it("[03-profiles#8.2] remembers a fact and injects it into the next conversation", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[
						{
							toolCall: {
								name: "memory_append",
								args: { note: "The build uses pnpm, not npm.", tags: ["project"] },
							},
						},
					],
					[{ text: "Noted." }],
				]);
				const profile = await makeProfile(t, me, {
					name: "Rememberer",
					toolNames: ["read"],
					memory: { enabled: true },
				});
				const workspace = await makeWorkspace(t, me, ws.path);
				const first = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				expect(first.conversation.tools.map((tool) => tool.name)).toContain("memory_append");

				const stream = await t.openSse(`/api/conversations/${first.conversation.id}/events`, me);
				await prompt(t, me, first.conversation.id, "remember that we use pnpm");
				await stream.waitFor(
					(frames) => frames.some((f) => f.json<UiEvent>().type === "done"),
					20_000,
				);
				// every append is visible in the transcript as a notice (spec/03 §5.3)
				const notices = stream.frames
					.map((f) => f.json<UiEvent>())
					.filter((e) => e.type === "notice");
				expect(notices.map((n) => (n as { text: string }).text).join(" ")).toContain(
					"Remembered: The build uses pnpm, not npm.",
				);
				stream.stop();

				const memoryFile = join(t.home, "profiles", profile.id, "memory.md");
				const memory = readFileSync(memoryFile, "utf8");
				expect(memory).toContain("## Pinned");
				expect(memory.match(/^- \[/gm)).toHaveLength(1);
				expect(memory).toContain("(tags: project) The build uses pnpm, not npm.");

				const second = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
					title: "Second",
				});
				expect(second.conversation.systemPromptPreview).toContain("The build uses pnpm, not npm.");
				expect(second.conversation.systemPromptPreview).toContain("Persistent memory");
			}, FAKE);
		});
	});

	it("[03-profiles#8.3] disabling memory drops the block and the tool but keeps the file", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				const profile = await makeProfile(t, me, {
					name: "Forgetful",
					toolNames: ["read"],
					memory: { enabled: true },
				});
				const memoryFile = join(t.home, "profiles", profile.id, "memory.md");
				mkdirSync(join(t.home, "profiles", profile.id), { recursive: true });
				writeFileSync(
					memoryFile,
					"# Memory — Forgetful\n\n## Pinned\n\n## Notes\n\n- [2025-01-01T00:00:00Z] pnpm not npm\n",
				);
				const workspace = await makeWorkspace(t, me, ws.path);

				const withMemory = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				expect(withMemory.conversation.systemPromptPreview).toContain("pnpm not npm");

				const patched = await t.app.inject({
					method: "PATCH",
					url: `/api/profiles/${profile.id}`,
					headers: { ...me.headers, ...json },
					payload: { memory: { enabled: false } },
				});
				expect(patched.statusCode).toBe(200);

				const without = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
					title: "After",
				});
				expect(without.conversation.systemPromptPreview).not.toContain("pnpm not npm");
				expect(without.conversation.tools.map((tool) => tool.name)).not.toContain("memory_append");
				expect(existsSync(memoryFile)).toBe(true);
			}, FAKE);
		});
	});

	it("[03-profiles#8.4] puts a selected skill's description in the prompt and lets the agent read it", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				const skillDir = join(t.home, "skills", "release-notes");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					"---\nname: release-notes\ndescription: Write release notes from a changelog.\n---\n\nSteps: read CHANGELOG.md.\n",
				);
				const listed = await t.app.inject({
					method: "GET",
					url: "/api/skills",
					headers: me.headers,
				});
				const skillId = listed.json<{ items: SkillSummary[] }>().items[0]!.id;

				t.services.fakeModel!.setScripts([
					[{ toolCall: { name: "read", args: { path: join(skillDir, "SKILL.md") } } }],
					[{ text: "Loaded the skill." }],
				]);
				const profile = await makeProfile(t, me, {
					name: "Releaser",
					toolNames: ["read"],
					skillIds: [skillId],
				});
				const workspace = await makeWorkspace(t, me, ws.path);
				const { conversation } = await newAgent(t, me, {
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				// progressive disclosure: description in the prompt, body only on demand
				expect(conversation.systemPromptPreview).toContain("Write release notes from a changelog.");
				expect(conversation.systemPromptPreview).not.toContain("Steps: read CHANGELOG.md.");

				const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
				await prompt(t, me, conversation.id, "write the release notes");
				await stream.waitFor(
					(frames) => frames.some((f) => f.json<UiEvent>().type === "done"),
					20_000,
				);
				const messages = (
					await t.app.inject({
						method: "GET",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: me.headers,
					})
				).json<MessagesResponse>().messages;
				const read = toolBlocks(messages).find((b) => b.name === "read")!;
				expect((read.args as { path: string }).path).toContain("release-notes/SKILL.md");
				expect(read.output).toContain("Steps: read CHANGELOG.md.");
				stream.stop();
			}, FAKE);
		});
	});
});
