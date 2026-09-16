// spec/03-profiles.md §§1-2,4-7 and spec/09-api.md §4 — profile CRUD with file side effects,
// validation, and the four memory routes.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ApiErrorBody,
	ProfileDetail,
	ProfileMemoryResponse,
	ProfileSummary,
	SkillSummary,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import type { MintedPrincipal } from "../support/principal.js";

const json = { "content-type": "application/json" };

async function createProfile(
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

function writeSkill(home: string, dir: string, name: string): void {
	const path = join(home, "skills", dir);
	mkdirSync(path, { recursive: true });
	writeFileSync(
		join(path, "SKILL.md"),
		`---\nname: ${name}\ndescription: A skill used by the profile tests.\n---\n\nBody.\n`,
	);
}

describe("profiles", () => {
	it("writes AGENTS.md to disk on save and lets the file win on an external edit", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const profile = await createProfile(t, me, {
				name: "Coding",
				agentsMd: "Always answer in French.",
				toolNames: ["read", "ls"],
			});
			const file = join(t.home, "profiles", profile.id, "AGENTS.md");
			expect(readFileSync(file, "utf8")).toBe("Always answer in French.");

			writeFileSync(file, "Edited by hand.");
			const res = await t.app.inject({
				method: "GET",
				url: `/api/profiles/${profile.id}`,
				headers: me.headers,
			});
			expect(res.json<ProfileDetail>().agentsMd).toBe("Edited by hand.");
		});
	});

	it("lists profiles without agentsMd but with its size and the conversation count", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			await createProfile(t, me, { name: "Reviewer", agentsMd: "12345", toolNames: ["read"] });
			const res = await t.app.inject({ method: "GET", url: "/api/profiles", headers: me.headers });
			const items = res.json<{ items: ProfileSummary[] }>().items;
			const reviewer = items.find((p) => p.name === "Reviewer")!;
			expect(reviewer.agentsMdSize).toBe(5);
			expect(reviewer.usedByConversations).toBe(0);
			expect(reviewer).not.toHaveProperty("agentsMd");
		});
	});

	it("refuses a duplicate name, an unknown tool and skills without read or bash", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			writeSkill(t.home, "helper", "helper");
			const skills = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			const skillId = skills.json<{ items: SkillSummary[] }>().items[0]!.id;

			await createProfile(t, me, { name: "Taken", toolNames: [] });
			const dup = await t.app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...me.headers, ...json },
				payload: { name: "Taken" },
			});
			expect(dup.statusCode).toBe(409);
			expect(dup.json<ApiErrorBody>().error.code).toBe("profile_name_taken");

			const unknownTool = await t.app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...me.headers, ...json },
				payload: { name: "Bad tools", toolNames: ["teleport"] },
			});
			expect(unknownTool.statusCode).toBe(400);
			expect(unknownTool.json<ApiErrorBody>().error.message).toContain("teleport");

			const noRead = await t.app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...me.headers, ...json },
				payload: { name: "Skills without read", skillIds: [skillId], toolNames: ["ls"] },
			});
			expect(noRead.statusCode).toBe(400);
			expect(noRead.json<ApiErrorBody>().error.message).toMatch(/read/i);

			const big = await t.app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...me.headers, ...json },
				payload: { name: "Huge", agentsMd: "x".repeat(256 * 1024 + 1) },
			});
			expect(big.statusCode).toBe(400);
			expect(big.json<ApiErrorBody>().error.code).toBe("agents_md_too_large");
		});
	});

	it("[03-profiles#8.5] warns instead of failing when a selected skill was deleted", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			writeSkill(t.home, "helper", "helper");
			const skills = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			const skillId = skills.json<{ items: SkillSummary[] }>().items[0]!.id;
			const profile = await createProfile(t, me, {
				name: "With skill",
				skillIds: [skillId],
				toolNames: ["read"],
			});
			expect(profile.warnings).toEqual([]);

			rmSync(join(t.home, "skills", "helper"), { recursive: true, force: true });
			const res = await t.app.inject({
				method: "GET",
				url: `/api/profiles/${profile.id}`,
				headers: me.headers,
			});
			expect(res.statusCode).toBe(200);
			const detail = res.json<ProfileDetail>();
			expect(detail.warnings.join(" ")).toMatch(/helper|missing|deleted/i);
			expect(detail.skillIds).toEqual([skillId]);
		});
	});

	it("moves the profile directory to trash on delete and never rm -rf's it", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const profile = await createProfile(t, me, { name: "Doomed", agentsMd: "keep me" });
			const dir = join(t.home, "profiles", profile.id);
			expect(existsSync(dir)).toBe(true);

			const res = await t.app.inject({
				method: "DELETE",
				url: `/api/profiles/${profile.id}`,
				headers: me.headers,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json<{ affectedConversations: number }>().affectedConversations).toBe(0);
			expect(existsSync(dir)).toBe(false);
			const trashed = readdirSync(join(t.home, "trash")).filter((name) =>
				name.startsWith(profile.id),
			);
			expect(trashed).toHaveLength(1);
			expect(readFileSync(join(t.home, "trash", trashed[0]!, "AGENTS.md"), "utf8")).toBe("keep me");
		});
	});

	it("duplicates the row and the directory", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const profile = await createProfile(t, me, {
				name: "Original",
				agentsMd: "instructions",
				toolNames: ["read", "ls"],
			});
			const res = await t.app.inject({
				method: "POST",
				url: `/api/profiles/${profile.id}/duplicate`,
				headers: me.headers,
			});
			expect(res.statusCode).toBe(201);
			const copy = res.json<ProfileDetail>();
			expect(copy.name).toBe("Original copy");
			expect(copy.agentsMd).toBe("instructions");
			expect(copy.toolNames).toEqual(["read", "ls"]);
			expect(copy.id).not.toBe(profile.id);
		});
	});

	it("seeds the three built-in profiles on first boot only", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const res = await t.app.inject({ method: "GET", url: "/api/profiles", headers: me.headers });
			const names = res.json<{ items: ProfileSummary[] }>().items.map((p) => p.name);
			expect(names).toEqual(
				expect.arrayContaining(["Coding agent", "Read-only reviewer", "Researcher"]),
			);
			const coding = res
				.json<{ items: ProfileSummary[] }>()
				.items.find((p) => p.name === "Coding agent")!;
			expect(coding.toolNames).toEqual(
				expect.arrayContaining(["read", "write", "edit", "bash", "grep", "find", "ls"]),
			);
		});
	});

	it("exposes the memory file for human curation and moves it to trash on delete", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const profile = await createProfile(t, me, {
				name: "Remembering",
				toolNames: ["read"],
				memory: { enabled: true },
			});

			const empty = await t.app.inject({
				method: "GET",
				url: `/api/profiles/${profile.id}/memory`,
				headers: me.headers,
			});
			expect(empty.statusCode).toBe(200);
			expect(empty.json<ProfileMemoryResponse>().sizeBytes).toBe(0);

			const put = await t.app.inject({
				method: "PUT",
				url: `/api/profiles/${profile.id}/memory`,
				headers: { ...me.headers, ...json },
				payload: { content: "# Memory — Remembering\n\n## Pinned\n\n## Notes\n\n- [t] a note\n" },
			});
			expect(put.statusCode).toBe(200);

			const read = await t.app.inject({
				method: "GET",
				url: `/api/profiles/${profile.id}/memory`,
				headers: me.headers,
			});
			const body = read.json<ProfileMemoryResponse>();
			expect(body.enabled).toBe(true);
			expect(body.content).toContain("a note");
			expect(body.noteCount).toBe(1);
			expect(body.injectedBytes).toBe(body.sizeBytes);
			expect(body.path).toBe(join(t.home, "profiles", profile.id, "memory.md"));

			const removed = await t.app.inject({
				method: "DELETE",
				url: `/api/profiles/${profile.id}/memory`,
				headers: me.headers,
			});
			expect(removed.statusCode).toBe(204);
			expect(existsSync(body.path)).toBe(false);
			expect(readdirSync(join(t.home, "trash")).length).toBeGreaterThan(0);
		});
	});
});
