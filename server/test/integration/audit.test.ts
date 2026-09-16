// spec/11-security.md §7 (audit log) and §3/§8 (redaction, error discipline).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import { withWorkspace } from "../support/workspace.js";

const json = { "content-type": "application/json" };
const FAKE = { env: { PIUI_FAKE_MODEL: "1" } };

interface AuditLine {
	ts: string;
	actor: string;
	action: string;
	target: string | null;
	outcome: string;
	[key: string]: unknown;
}

function auditLines(home: string): AuditLine[] {
	const path = join(home, "logs", "audit.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as AuditLine);
}

describe("audit log", () => {
	it("[11-security#7.1] records actor, action, target and outcome for every mutation", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const created = await t.app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...me.headers, ...json },
				payload: { name: "Audited" },
			});
			expect(created.statusCode).toBe(201);
			const profileId = created.json<{ id: string }>().id;
			await t.app.inject({
				method: "PATCH",
				url: `/api/profiles/${profileId}`,
				headers: { ...me.headers, ...json },
				payload: { name: "Audited twice" },
			});
			await t.app.inject({
				method: "DELETE",
				url: `/api/profiles/${profileId}`,
				headers: me.headers,
			});
			// a read must not produce a line: mutations only (M7 decision)
			await t.app.inject({ method: "GET", url: "/api/profiles", headers: me.headers });

			const lines = auditLines(t.home);
			const actions = lines.map((l) => l.action);
			expect(actions).toEqual(["profile.create", "profile.update", "profile.delete"]);
			for (const line of lines) {
				expect(line.actor).toBe("local");
				expect(line.outcome).toBe("ok");
				expect(typeof line.ts).toBe("string");
			}
			expect(lines[1]!.target).toBe(profileId);
		});
	});

	it("[11-security#7.2] records login success, login failure and a refused mutation", async () => {
		await withTestApp(async (t) => {
			await t.app.inject({
				method: "POST",
				url: "/api/auth/login",
				headers: json,
				payload: { username: "test", password: "test" },
			});
			await t.app.inject({
				method: "POST",
				url: "/api/auth/login",
				headers: json,
				payload: { username: "test", password: "wrong-password" },
			});
			// a non-admin touching an admin-only surface is a denied mutation
			const bob = t.mint({ id: "bob", role: "user" });
			await t.app.inject({
				method: "PATCH",
				url: "/api/tools/bash",
				headers: { ...bob.headers, ...json },
				payload: { enabled: false },
			});

			const lines = auditLines(t.home);
			const login = lines.filter((l) => l.action === "auth.login");
			expect(login.map((l) => l.outcome)).toEqual(["ok", "denied"]);
			const denied = lines.find((l) => l.action === "tool.update");
			expect(denied?.outcome).toBe("denied");
			expect(denied?.actor).toBe("bob");
			// no password, ever
			expect(readFileSync(join(t.home, "logs", "audit.jsonl"), "utf8")).not.toContain(
				"wrong-password",
			);
		});
	});

	it("[11-security#7.3] records a dangerous tool call with the conversation id, truncated and redacted", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(async (t) => {
				const me = t.mint();
				t.services.fakeModel!.setScripts([
					[
						{
							toolCall: {
								name: "write",
								args: {
									path: "note.txt",
									content: `sk-ant-api03-abcdefghijklmnop ${"x".repeat(500)}`,
								},
							},
						},
					],
					[{ text: "done" }],
				]);
				const profile = (
					await t.app.inject({
						method: "POST",
						url: "/api/profiles",
						headers: { ...me.headers, ...json },
						payload: { name: "Writer", toolNames: ["write"] },
					})
				).json<{ id: string }>();
				const workspace = (
					await t.app.inject({
						method: "POST",
						url: "/api/workspaces",
						headers: { ...me.headers, ...json },
						payload: { name: "ws", path: ws.path },
					})
				).json<{ id: string }>();
				const fake = t.services.fakeModel!;
				const conversationId = (
					await t.app.inject({
						method: "POST",
						url: "/api/conversations",
						headers: { ...me.headers, ...json },
						payload: {
							mode: "agent",
							provider: fake.providerId,
							modelId: fake.modelId,
							profileId: profile.id,
							workspaceId: workspace.id,
							title: "audited run",
						},
					})
				).json<{ conversation: { id: string } }>().conversation.id;

				await t.app.inject({
					method: "POST",
					url: `/api/conversations/${conversationId}/messages`,
					headers: { ...me.headers, ...json },
					payload: { text: "write the note" },
				});
				await waitUntil(() => auditLines(t.home).some((l) => l.action === "tool.invoke"), 20_000);

				const line = auditLines(t.home).find((l) => l.action === "tool.invoke")!;
				expect(line.target).toBe("write");
				expect(line.conversationId).toBe(conversationId);
				// a truncated argument summary, never the full content (§7 last rule)
				expect(String(line.args)).toContain("note.txt");
				expect(String(line.args).length).toBeLessThanOrEqual(200);
				// spec/11-security.md §3: nothing key-shaped survives into the log.
				const raw = readFileSync(join(t.home, "logs", "audit.jsonl"), "utf8");
				expect(raw).not.toContain("sk-ant-api03-abcdefghijklmnop");
			}, FAKE);
		});
	});

	it("[11-security#3.2] never records a request body, so no credential can reach the log", async () => {
		await withTestApp(async (t) => {
			t.mint();
			await t.app.inject({
				method: "POST",
				url: "/api/auth/login",
				headers: json,
				payload: { username: "test", password: "sk-ant-api03-abcdefghijklmnop" },
			});
			const raw = readFileSync(join(t.home, "logs", "audit.jsonl"), "utf8");
			expect(raw).toContain("auth.login");
			expect(raw).not.toContain("sk-ant-api03");
			expect(raw).not.toContain("password");
		});
	});
});
