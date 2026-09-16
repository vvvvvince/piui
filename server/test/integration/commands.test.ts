// spec/15-commands-and-input.md §§1-3, 5 — the command surface, prompt templates, workspace
// trust and discovered skills. Argument substitution is asserted on **pi's output** (§6.3).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	CommandsResponse,
	ConversationDetail,
	CreateConversationResponse,
	MessagesResponse,
	ProfileDetail,
	ProjectResourcesResponse,
	PromptsResponse,
	SkillSummary,
	Workspace,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";
import { createWorkspace, withWorkspace } from "../support/workspace.js";

const json = { "content-type": "application/json" };

// The "user" source (~/.pi/agent/prompts) is redirected to <temp home>/user-pi/agent by
// createTempHome, so no test can read or write the real ~/.pi.
const FAKE = { env: { PIUI_FAKE_MODEL: "1" } };

function plant(dir: string, file: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
}

function plantSkill(dir: string, name: string, description: string, body = "Use pdftotext.\n") {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
	);
}

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

async function makeWorkspace(t: TestApp, who: MintedPrincipal, path: string): Promise<Workspace> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/workspaces",
		headers: { ...who.headers, ...json },
		payload: { name: "ws", path },
	});
	expect(res.statusCode).toBe(201);
	return res.json<Workspace>();
}

async function newConversation(
	t: TestApp,
	who: MintedPrincipal,
	body: Record<string, unknown>,
): Promise<ConversationDetail> {
	const fake = t.services.fakeModel!;
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...who.headers, ...json },
		payload: { provider: fake.providerId, modelId: fake.modelId, title: "T", ...body },
	});
	expect(res.statusCode).toBe(201);
	return res.json<CreateConversationResponse>().conversation;
}

async function commands(
	t: TestApp,
	who: MintedPrincipal,
	id: string,
): Promise<CommandsResponse["items"]> {
	const res = await t.app.inject({
		method: "GET",
		url: `/api/conversations/${id}/commands`,
		headers: who.headers,
	});
	expect(res.statusCode).toBe(200);
	return res.json<CommandsResponse>().items;
}

async function run(
	t: TestApp,
	who: MintedPrincipal,
	id: string,
	text: string,
): Promise<MessagesResponse> {
	const res = await t.app.inject({
		method: "POST",
		url: `/api/conversations/${id}/messages`,
		headers: { ...who.headers, ...json },
		payload: { text },
	});
	expect(res.statusCode).toBe(202);
	await waitUntil(() => t.services.hub.peek(id)?.session.isStreaming === false);
	const messages = await t.app.inject({
		method: "GET",
		url: `/api/conversations/${id}/messages`,
		headers: who.headers,
	});
	return messages.json<MessagesResponse>();
}

const userText = (m: MessagesResponse): string => {
	const users = m.messages.filter((message) => message.role === "user");
	const last = users[users.length - 1]!;
	return last.blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
};

describe("command surface", () => {
	it("[15-commands-and-input#6.1] lists built-ins, the profile's skills and templates from all three sources", async () => {
		const ws = createWorkspace({});
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				plant(
					join(t.home, "prompts"),
					"piui-only.md",
					"---\ndescription: A piui template\n---\n\nDo it.\n",
				);
				plant(
					join(t.home, "user-pi", "agent", "prompts"),
					"review.md",
					"---\ndescription: Review a PR\nargument-hint: <PR-URL>\n---\n\nReview $1.\n",
				);
				plant(
					join(ws.path, ".pi", "prompts"),
					"component.md",
					"---\ndescription: Scaffold\nargument-hint: <Name> <behaviour>\n---\n\nCreate $1 handling $@.\n",
				);
				plantSkill(join(t.home, "skills", "pdf-tools"), "pdf-tools", "Read PDFs.");

				const skills = await t.app.inject({
					method: "GET",
					url: "/api/skills",
					headers: me.headers,
				});
				const skillId = skills.json<{ items: SkillSummary[] }>().items[0]!.id;
				const profile = await makeProfile(t, me, {
					name: "P",
					skillIds: [skillId],
					toolNames: ["read"],
				});
				const workspace = await makeWorkspace(t, me, ws.path);
				await t.app.inject({
					method: "PATCH",
					url: `/api/workspaces/${workspace.id}`,
					headers: { ...me.headers, ...json },
					payload: { trusted: true },
				});
				const conversation = await newConversation(t, me, {
					mode: "agent",
					profileId: profile.id,
					workspaceId: workspace.id,
				});

				const items = await commands(t, me, conversation.id);
				expect(items.some((c) => c.name === "hotkeys" && c.source === "builtin")).toBe(true);

				const skill = items.find((c) => c.name === "skill:pdf-tools")!;
				expect(skill).toMatchObject({
					display: "/skill:pdf-tools",
					source: "skill",
					kind: "expand",
					availableWhileStreaming: true,
					description: "Read PDFs.",
				});

				const byName = new Map(items.map((c) => [c.name, c]));
				expect(byName.get("piui-only")!.location).toBe("piui");
				expect(byName.get("review")).toMatchObject({
					location: "user",
					argumentHint: "<PR-URL>",
					description: "Review a PR",
					source: "prompt",
					kind: "expand",
				});
				expect(byName.get("component")!.location).toBe("project");
			}, FAKE);
		} finally {
			ws.cleanup();
		}
	});

	it("[15-commands-and-input#6.3] lets pi substitute $1 and $@, and echoes the typed command", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				t.services.fakeModel!.setScripts([[{ text: "done" }]]);
				const me = t.mint();
				plant(
					join(ws.path, ".pi", "prompts"),
					"component.md",
					"---\ndescription: Scaffold\n---\n\nCreate component $1 that handles $@.\n",
				);
				const profile = await makeProfile(t, me, { name: "P", toolNames: [] });
				const workspace = await makeWorkspace(t, me, ws.path);
				await t.app.inject({
					method: "PATCH",
					url: `/api/workspaces/${workspace.id}`,
					headers: { ...me.headers, ...json },
					payload: { trusted: true },
				});
				const conversation = await newConversation(t, me, {
					mode: "agent",
					profileId: profile.id,
					workspaceId: workspace.id,
				});

				const messages = await run(t, me, conversation.id, '/component Button "click handler"');
				// Asserted on pi's output — piui never parses arguments (spec §6.3).
				expect(userText(messages)).toBe(
					"Create component Button that handles Button click handler.",
				);
				const user = messages.messages.find((m) => m.role === "user")!;
				expect(user.commandEcho).toEqual({
					typed: '/component Button "click handler"',
					expandedChars: "Create component Button that handles Button click handler.".length,
				});
			}, FAKE);
		});
	});

	it("[15-commands-and-input#6.2] expands a ~/.pi/agent/prompts template exactly as the terminal does", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				t.services.fakeModel!.setScripts([[{ text: "reviewed" }]]);
				const me = t.mint();
				plant(
					join(t.home, "user-pi", "agent", "prompts"),
					"review.md",
					"---\ndescription: Review a PR\nargument-hint: <PR-URL>\n---\n\nReview $1 carefully.\n",
				);
				const profile = await makeProfile(t, me, { name: "P", toolNames: [] });
				const workspace = await makeWorkspace(t, me, ws.path);
				const conversation = await newConversation(t, me, {
					mode: "agent",
					profileId: profile.id,
					workspaceId: workspace.id,
				});

				const messages = await run(t, me, conversation.id, "/review https://example.com/pr/1");
				expect(userText(messages)).toBe("Review https://example.com/pr/1 carefully.");
				expect(messages.messages.find((m) => m.role === "user")!.commandEcho!.typed).toBe(
					"/review https://example.com/pr/1",
				);
			}, FAKE);
		});
	});

	it("[15-commands-and-input#6.4] expands /skill:<name> with its SKILL.md body and the arguments", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				t.services.fakeModel!.setScripts([[{ text: "extracted" }]]);
				const me = t.mint();
				plantSkill(join(t.home, "skills", "pdf-tools"), "pdf-tools", "Read PDFs.");
				const skills = await t.app.inject({
					method: "GET",
					url: "/api/skills",
					headers: me.headers,
				});
				const skillId = skills.json<{ items: SkillSummary[] }>().items[0]!.id;
				const profile = await makeProfile(t, me, {
					name: "P",
					skillIds: [skillId],
					toolNames: ["read"],
				});
				const workspace = await makeWorkspace(t, me, ws.path);
				const conversation = await newConversation(t, me, {
					mode: "agent",
					profileId: profile.id,
					workspaceId: workspace.id,
				});

				const messages = await run(t, me, conversation.id, "/skill:pdf-tools extract");
				const text = userText(messages);
				expect(text).toContain('<skill name="pdf-tools"');
				expect(text).toContain("Use pdftotext.");
				expect(text.trimEnd().endsWith("extract")).toBe(true);
			}, FAKE);
		});
	});

	it("[15-commands-and-input#6.10] shows built-ins and templates but no skill commands in chat mode", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			plant(join(t.home, "prompts"), "note.md", "---\ndescription: Note\n---\n\nNote $1.\n");
			plantSkill(join(t.home, "skills", "pdf-tools"), "pdf-tools", "Read PDFs.");
			await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });

			const conversation = await newConversation(t, me, { mode: "chat" });
			const items = await commands(t, me, conversation.id);
			expect(items.some((c) => c.source === "skill")).toBe(false);
			expect(items.some((c) => c.name === "note" && c.source === "prompt")).toBe(true);
			expect(items.some((c) => c.source === "builtin")).toBe(true);
			// chat mode has no workspace and therefore no project templates, and no filesystem tools
			expect(items.every((c) => c.location !== "project")).toBe(true);
			expect(conversation.tools).toEqual([]);
		}, FAKE);
	});
});

describe("prompt template routes", () => {
	it("[15-commands-and-input#6.1] GET /api/prompts lists the global sources with counts", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			plant(join(t.home, "prompts"), "a.md", "---\ndescription: A\n---\n\nA.\n");
			plant(
				join(t.home, "user-pi", "agent", "prompts"),
				"a.md",
				"---\ndescription: A from the user\n---\n\nA user.\n",
			);
			const res = await t.app.inject({ method: "GET", url: "/api/prompts", headers: me.headers });
			expect(res.statusCode).toBe(200);
			const body = res.json<PromptsResponse>();
			expect(body.items).toHaveLength(1);
			expect(body.items[0]).toMatchObject({ name: "a", location: "user", shadows: ["piui"] });
			expect(body.sources.map((s) => `${s.location}:${s.count}`)).toEqual(["piui:1", "user:1"]);
		}, FAKE);
	});

	it("[15-commands-and-input#6.1] POST /api/prompts/rescan reports the delta and is admin-only", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const user = t.mint({ id: "bob", role: "user" });
			plant(join(t.home, "prompts"), "a.md", "A.\n");
			await t.app.inject({ method: "GET", url: "/api/prompts", headers: me.headers });

			plant(join(t.home, "prompts"), "b.md", "B.\n");
			plant(join(t.home, "prompts"), "a.md", "A, edited.\n");
			const res = await t.app.inject({
				method: "POST",
				url: "/api/prompts/rescan",
				headers: me.headers,
			});
			expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
			expect(res.json()).toEqual({ added: 1, updated: 1, removed: 0 });

			const forbidden = await t.app.inject({
				method: "POST",
				url: "/api/prompts/rescan",
				headers: user.headers,
			});
			expect(forbidden.statusCode).toBe(403);
		}, FAKE);
	});
});

describe("workspace trust", () => {
	it("[15-commands-and-input#6.8] hides project templates until the workspace is trusted, without a restart", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				plant(
					join(ws.path, ".pi", "prompts"),
					"component.md",
					"---\ndescription: C\n---\n\nC $1.\n",
				);
				plantSkill(join(ws.path, ".pi", "skills", "proj"), "proj", "Project skill.");
				const profile = await makeProfile(t, me, { name: "P", toolNames: [] });
				const workspace = await makeWorkspace(t, me, ws.path);
				expect(workspace.trusted).toBe(false);

				const resources = await t.app.inject({
					method: "GET",
					url: `/api/workspaces/${workspace.id}/project-resources`,
					headers: me.headers,
				});
				expect(resources.statusCode).toBe(200);
				expect(resources.json<ProjectResourcesResponse>()).toMatchObject({
					hasPiDir: true,
					prompts: ["component"],
					skills: ["proj"],
					extensions: [],
					settings: false,
					trusted: false,
					trustDecidedAt: null,
				});

				const conversation = await newConversation(t, me, {
					mode: "agent",
					profileId: profile.id,
					workspaceId: workspace.id,
				});
				expect((await commands(t, me, conversation.id)).some((c) => c.name === "component")).toBe(
					false,
				);

				const patched = await t.app.inject({
					method: "PATCH",
					url: `/api/workspaces/${workspace.id}`,
					headers: { ...me.headers, ...json },
					payload: { trusted: true },
				});
				expect(patched.statusCode).toBe(200);
				expect(patched.json<Workspace>().trusted).toBe(true);
				expect(patched.json<Workspace>().trustDecidedAt).not.toBeNull();

				// Same process, same conversation: the template appears without a restart, and the
				// *running* session expands it — the pi session that held the old set was dropped.
				const after = await commands(t, me, conversation.id);
				expect(after.some((c) => c.name === "component" && c.location === "project")).toBe(true);

				t.services.fakeModel!.setScripts([[{ text: "ok" }]]);
				const messages = await run(t, me, conversation.id, "/component Button");
				expect(userText(messages)).toBe("C Button.");
			}, FAKE);
		});
	});
});

describe("discovered skills", () => {
	it("[15-commands-and-input#6.9] registers ~/.pi/agent/skills as external, inactive until a profile selects it", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			plantSkill(
				join(t.home, "user-pi", "agent", "skills", "tui-skill"),
				"tui-skill",
				"Discovered in the terminal.",
			);
			const res = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			const items = res.json<{ items: SkillSummary[] }>().items;
			const discovered = items.find((s) => s.name === "tui-skill")!;
			expect(discovered.source).toBe("external");
			expect(discovered.usedByProfiles).toBe(0);

			const profile = await makeProfile(t, me, { name: "P", toolNames: [] });
			expect(t.services.profiles.resolve(profile.id).skills).toEqual([]);
		}, FAKE);
	});

	it("[15-commands-and-input#6.9] activates every discovered skill when includeDiscoveredSkills is on", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			plantSkill(join(t.home, "user-pi", "agent", "skills", "a"), "a-skill", "A.");
			plantSkill(join(t.home, "skills", "managed"), "managed-skill", "M.");
			await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });

			const profile = await makeProfile(t, me, {
				name: "P",
				toolNames: [],
				includeDiscoveredSkills: true,
			});
			const resolved = t.services.profiles.resolve(profile.id);
			expect(resolved.skills.map((s) => s.name).sort()).toEqual(["a-skill"]);
			expect(resolved.discoveredSkillCount).toBe(1);
		}, FAKE);
	});
});
