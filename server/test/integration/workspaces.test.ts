// spec/04-workspaces.md §§1-7 and spec/09-api.md §5 — the workspace surface.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	DeleteWorkspaceResponse,
	FsBrowseResponse,
	ValidatePathResponse,
	Workspace,
	WorkspaceFileResponse,
	WorkspaceGitResponse,
	WorkspacesResponse,
	WorkspaceTreeResponse,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import type { MintedPrincipal } from "../support/principal.js";
import { createWorkspace } from "../support/workspace.js";

const json = { "content-type": "application/json" };
const errorCode = (res: { json: <T>() => T }): string =>
	res.json<{ error: { code: string } }>().error.code;

async function register(
	t: TestApp,
	who: MintedPrincipal,
	body: Record<string, unknown>,
): Promise<{ statusCode: number; json: <T>() => T }> {
	return t.app.inject({
		method: "POST",
		url: "/api/workspaces",
		headers: { ...who.headers, ...json },
		payload: body,
	});
}

describe("workspaces", () => {
	it("[04-workspaces#1] registers a folder, lists it with a live status, and reads it back", async () => {
		const ws = createWorkspace();
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const created = await register(t, me, {
					name: "Demo",
					path: `${ws.path}/`,
					description: "a fixture",
				});
				expect(created.statusCode).toBe(201);
				const workspace = created.json<Workspace>();
				expect(workspace).toMatchObject({
					name: "Demo",
					path: ws.path,
					description: "a fixture",
					activeConversations: 0,
					status: { exists: true, writable: true, isGitRepo: false },
				});
				expect(workspace.status.entryCount).toBe(3);

				const list = await t.app.inject({ url: "/api/workspaces", headers: me.headers });
				expect(list.json<WorkspacesResponse>().items).toHaveLength(1);

				const one = await t.app.inject({
					url: `/api/workspaces/${workspace.id}`,
					headers: me.headers,
				});
				expect(one.json<Workspace>().id).toBe(workspace.id);
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[04-workspaces#7.1] refuses /etc with path_denylisted and accepts an ordinary folder", async () => {
		const ws = createWorkspace();
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const denied = await register(t, me, { name: "System", path: "/etc" });
				expect(denied.statusCode).toBe(403);
				expect(errorCode(denied)).toBe("path_denylisted");

				const piuiHome = await register(t, me, { name: "Home", path: t.home });
				expect(errorCode(piuiHome)).toBe("path_denylisted");

				expect((await register(t, me, { name: "Demo", path: ws.path })).statusCode).toBe(201);
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[04-workspaces#7.2] refuses a symlink that escapes PIUI_WORKSPACE_ROOTS", async () => {
		const roots = createWorkspace({});
		const outside = createWorkspace({});
		try {
			mkdirSync(join(roots.path, "inside"));
			execFileSync("ln", ["-s", outside.path, join(roots.path, "escape")]);
			await withTestApp(
				async (t) => {
					const me = t.mint();
					const escaped = await register(t, me, {
						name: "Escape",
						path: join(roots.path, "escape"),
					});
					expect(escaped.statusCode).toBe(403);
					expect(errorCode(escaped)).toBe("path_not_allowed");

					// spec/19-deployment.md §9.5, second half: a path outside the roots is refused
					const beyond = await register(t, me, { name: "Beyond", path: outside.path });
					expect(errorCode(beyond)).toBe("path_not_allowed");

					expect(
						(await register(t, me, { name: "Inside", path: join(roots.path, "inside") }))
							.statusCode,
					).toBe(201);
				},
				{ env: { PIUI_WORKSPACE_ROOTS: roots.path } },
			);
		} finally {
			roots.cleanup();
			outside.cleanup();
		}
	});

	it("[09-api#5] answers each remaining rejection with its own machine code", async () => {
		const ws = createWorkspace();
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				expect(errorCode(await register(t, me, { name: "Rel", path: "relative/path" }))).toBe(
					"path_not_absolute",
				);
				expect(
					errorCode(await register(t, me, { name: "Gone", path: join(ws.path, "nope") })),
				).toBe("path_not_found");
				expect(
					errorCode(await register(t, me, { name: "File", path: join(ws.path, "README.md") })),
				).toBe("path_not_directory");

				expect((await register(t, me, { name: "Demo", path: ws.path })).statusCode).toBe(201);
				expect(errorCode(await register(t, me, { name: "Again", path: ws.path }))).toBe(
					"path_already_registered",
				);
				const other = createWorkspace({});
				try {
					expect(errorCode(await register(t, me, { name: "Demo", path: other.path }))).toBe(
						"workspace_name_taken",
					);
				} finally {
					other.cleanup();
				}
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[09-api#5] validates a path for live form feedback without registering anything", async () => {
		const ws = createWorkspace();
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const ok = await t.app.inject({
					method: "POST",
					url: "/api/workspaces/validate",
					headers: { ...me.headers, ...json },
					payload: { path: `${ws.path}/./` },
				});
				expect(ok.statusCode).toBe(200);
				expect(ok.json<ValidatePathResponse>()).toMatchObject({
					ok: true,
					normalizedPath: ws.path,
					status: { exists: true, writable: true, isGitRepo: false },
				});

				const bad = await t.app.inject({
					method: "POST",
					url: "/api/workspaces/validate",
					headers: { ...me.headers, ...json },
					payload: { path: "/etc" },
				});
				expect(bad.statusCode).toBe(403);
				expect(errorCode(bad)).toBe("path_denylisted");
				expect(t.app.inject).toBeDefined();

				const list = await t.app.inject({ url: "/api/workspaces", headers: me.headers });
				expect(list.json<WorkspacesResponse>().items).toEqual([]);
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[04-workspaces#7.3] creates the folder and runs git init when asked", async () => {
		const parent = createWorkspace({});
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const target = join(parent.path, "fresh");
				const created = await register(t, me, {
					name: "Fresh",
					path: target,
					create: true,
					gitInit: true,
				});
				expect(created.statusCode).toBe(201);
				expect(existsSync(target)).toBe(true);
				expect(existsSync(join(target, ".git"))).toBe(true);
				expect(created.json<Workspace>().status).toMatchObject({ exists: true, isGitRepo: true });

				const git = await t.app.inject({
					url: `/api/workspaces/${created.json<Workspace>().id}/git`,
					headers: me.headers,
				});
				expect(git.json<WorkspaceGitResponse>()).toMatchObject({
					available: true,
					dirtyCount: 0,
				});
			});
		} finally {
			parent.cleanup();
		}
	});

	it("[04-workspaces#3] lists a directory level, flags hidden entries and refuses an escape", async () => {
		const ws = createWorkspace();
		try {
			ws.write(".hidden/keep.txt", "x");
			await withTestApp(async (t) => {
				const me = t.mint();
				const id = (await register(t, me, { name: "Demo", path: ws.path })).json<Workspace>().id;

				const root = await t.app.inject({
					url: `/api/workspaces/${id}/tree`,
					headers: me.headers,
				});
				const entries = root.json<WorkspaceTreeResponse>().entries;
				expect(entries.map((e) => e.name)).toEqual([".hidden", "docs", "src", "README.md"]);
				expect(entries.find((e) => e.name === ".hidden")).toMatchObject({
					kind: "dir",
					hidden: true,
				});
				expect(entries.find((e) => e.name === "README.md")).toMatchObject({
					kind: "file",
					size: 41,
				});

				const sub = await t.app.inject({
					url: `/api/workspaces/${id}/tree?path=src`,
					headers: me.headers,
				});
				expect(sub.json<WorkspaceTreeResponse>().entries.map((e) => e.name)).toEqual([
					"util",
					"index.ts",
				]);

				for (const path of ["..", "../..", "src/../../etc", "/etc"]) {
					const escaped = await t.app.inject({
						url: `/api/workspaces/${id}/tree?path=${encodeURIComponent(path)}`,
						headers: me.headers,
					});
					expect(escaped.statusCode, path).toBe(400);
					expect(errorCode(escaped), path).toBe("path_escape");
				}
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[04-workspaces#3] serves a text file, caps it at 512 KB and refuses a binary one", async () => {
		const ws = createWorkspace();
		try {
			ws.write("big.txt", "a".repeat(600 * 1024));
			writeFileSync(join(ws.path, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01, 0x02]));
			await withTestApp(async (t) => {
				const me = t.mint();
				const id = (await register(t, me, { name: "Demo", path: ws.path })).json<Workspace>().id;
				const read = async (path: string) =>
					t.app.inject({
						url: `/api/workspaces/${id}/file?path=${encodeURIComponent(path)}`,
						headers: me.headers,
					});

				const text = await read("src/index.ts");
				expect(text.statusCode).toBe(200);
				expect(text.json<WorkspaceFileResponse>()).toMatchObject({
					path: "src/index.ts",
					content: "export const answer = 42;\n",
					truncated: false,
					language: "typescript",
				});

				const big = await read("big.txt");
				const body = big.json<WorkspaceFileResponse>();
				expect(body.truncated).toBe(true);
				expect(body.content.length).toBe(512 * 1024);

				const binary = await read("logo.png");
				expect(binary.statusCode).toBe(415);
				expect(errorCode(binary)).toBe("binary_file");

				const escaped = await read("../secrets");
				expect(errorCode(escaped)).toBe("path_escape");
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[04-workspaces#7.4] shows a file written after the first read, without any cache to invalidate", async () => {
		const ws = createWorkspace();
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const id = (await register(t, me, { name: "Demo", path: ws.path })).json<Workspace>().id;
				const tree = async () =>
					(await t.app.inject({ url: `/api/workspaces/${id}/tree`, headers: me.headers }))
						.json<WorkspaceTreeResponse>()
						.entries.map((e) => e.name);

				expect(await tree()).not.toContain("agent-wrote-this.md");
				// what an agent run does, minus the agent (agent mode is M5)
				ws.write("agent-wrote-this.md", "# written during a run\n");
				expect(await tree()).toContain("agent-wrote-this.md");
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[04-workspaces#7.5] marks a renamed folder Missing and blocks new prompts with 409", async () => {
		const ws = createWorkspace();
		const moved = `${ws.path}-renamed`;
		try {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					const id = (await register(t, me, { name: "Demo", path: ws.path })).json<Workspace>().id;
					const conversation = t.ctx.repos.conversations.create(me.principal, {
						mode: "agent",
						provider: t.services.fakeModel!.providerId,
						modelId: t.services.fakeModel!.modelId,
						workspaceId: id,
						title: "In a workspace",
					});

					renameSync(ws.path, moved);

					const list = await t.app.inject({ url: "/api/workspaces", headers: me.headers });
					expect(list.json<WorkspacesResponse>().items[0]!.status).toMatchObject({
						exists: false,
						writable: false,
					});
					// it must NOT be auto-deleted
					expect(list.json<WorkspacesResponse>().items).toHaveLength(1);

					const prompt = await t.app.inject({
						method: "POST",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: { ...me.headers, ...json },
						payload: { text: "keep going" },
					});
					expect(prompt.statusCode).toBe(409);
					expect(errorCode(prompt)).toBe("workspace_missing");
					expect(prompt.json<{ error: { message: string } }>().error.message).toMatch(
						/folder|missing|moved/i,
					);

					// and the Relocate action: PATCH the path back
					const relocate = await t.app.inject({
						method: "PATCH",
						url: `/api/workspaces/${id}`,
						headers: { ...me.headers, ...json },
						payload: { path: moved },
					});
					expect(relocate.statusCode).toBe(200);
					expect(relocate.json<Workspace>().status.exists).toBe(true);
				},
				{ env: { PIUI_FAKE_MODEL: "1" } },
			);
		} finally {
			for (const dir of [ws.path, moved]) {
				try {
					execFileSync("rm", ["-rf", dir]);
				} catch {
					/* already gone */
				}
			}
		}
	});

	it("[04-workspaces#4] refuses a path change once a conversation has started in the workspace", async () => {
		const ws = createWorkspace();
		const other = createWorkspace({});
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const id = (await register(t, me, { name: "Demo", path: ws.path })).json<Workspace>().id;
				const conversation = t.ctx.repos.conversations.create(me.principal, {
					mode: "agent",
					provider: "p",
					modelId: "m",
					workspaceId: id,
				});
				t.ctx.repos.conversations.setSessionPathById(conversation.id, join(t.home, "s.jsonl"));

				const patch = await t.app.inject({
					method: "PATCH",
					url: `/api/workspaces/${id}`,
					headers: { ...me.headers, ...json },
					payload: { path: other.path },
				});
				expect(patch.statusCode).toBe(409);
				expect(errorCode(patch)).toBe("immutable_after_start");

				// name and description stay editable
				const renamed = await t.app.inject({
					method: "PATCH",
					url: `/api/workspaces/${id}`,
					headers: { ...me.headers, ...json },
					payload: { name: "Renamed", description: "still fine" },
				});
				expect(renamed.statusCode).toBe(200);
				expect(renamed.json<Workspace>()).toMatchObject({
					name: "Renamed",
					description: "still fine",
					activeConversations: 1,
				});
			});
		} finally {
			ws.cleanup();
			other.cleanup();
		}
	});

	it("[04-workspaces#7.6] deletes the record, detaches conversations and leaves every file on disk", async () => {
		const ws = createWorkspace();
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const id = (await register(t, me, { name: "Demo", path: ws.path })).json<Workspace>().id;
				const conversation = t.ctx.repos.conversations.create(me.principal, {
					mode: "agent",
					provider: "p",
					modelId: "m",
					workspaceId: id,
				});

				const deleted = await t.app.inject({
					method: "DELETE",
					url: `/api/workspaces/${id}`,
					headers: me.headers,
				});
				expect(deleted.statusCode).toBe(200);
				expect(deleted.json<DeleteWorkspaceResponse>()).toEqual({ affectedConversations: 1 });

				expect(existsSync(ws.path)).toBe(true);
				expect(readFileSync(ws.file("README.md"), "utf8")).toMatch(/fixture workspace/);
				expect(
					(
						await t.app.inject({ url: "/api/workspaces", headers: me.headers })
					).json<WorkspacesResponse>().items,
				).toEqual([]);
				expect(t.ctx.repos.conversations.getById(conversation.id)?.workspace_id).toBeNull();
			});
		} finally {
			ws.cleanup();
		}
	});

	it("[18-multi-user#9.4] hides another user's workspace behind 404", async () => {
		const ws = createWorkspace();
		try {
			await withTestApp(async (t) => {
				const me = t.mint();
				const id = (await register(t, me, { name: "Demo", path: ws.path })).json<Workspace>().id;
				const bob = t.mint({ id: "bob", role: "user" });
				const res = await t.app.inject({ url: `/api/workspaces/${id}`, headers: bob.headers });
				expect(res.statusCode).toBe(404);
			});
		} finally {
			ws.cleanup();
		}
	});
});

describe("GET /api/fs/browse", () => {
	it("[09-api#5] lists directories only, honours the denylist and stays admin-only", async () => {
		const roots = createWorkspace({});
		try {
			mkdirSync(join(roots.path, "alpha"));
			mkdirSync(join(roots.path, "beta"));
			writeFileSync(join(roots.path, "note.txt"), "not a directory");
			await withTestApp(
				async (t) => {
					const admin = t.mint();
					const browse = await t.app.inject({
						url: `/api/fs/browse?path=${encodeURIComponent(roots.path)}`,
						headers: admin.headers,
					});
					expect(browse.statusCode).toBe(200);
					expect(browse.json<FsBrowseResponse>()).toMatchObject({
						path: roots.path,
						dirs: ["alpha", "beta"],
					});

					// no path: the configured roots are the starting point
					const start = await t.app.inject({ url: "/api/fs/browse", headers: admin.headers });
					expect(start.json<FsBrowseResponse>().dirs).toContain("alpha");

					const denied = await t.app.inject({
						url: "/api/fs/browse?path=/etc",
						headers: admin.headers,
					});
					expect(denied.statusCode).toBe(403);
					expect(errorCode(denied)).toBe("path_denylisted");

					const bob = t.mint({ id: "bob", role: "user" });
					const forbidden = await t.app.inject({
						url: `/api/fs/browse?path=${encodeURIComponent(roots.path)}`,
						headers: bob.headers,
					});
					expect(forbidden.statusCode).toBe(403);
					expect(errorCode(forbidden)).toBe("forbidden");
				},
				{ env: { PIUI_WORKSPACE_ROOTS: roots.path } },
			);
		} finally {
			roots.cleanup();
		}
	});
});
