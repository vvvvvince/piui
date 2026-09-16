// spec/05-skills-and-tools.md §§A.2, A.4, A.5 — the M6 skill write path.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	DeleteSkillResponse,
	SkillDetail,
	SkillFileResponse,
	SkillSummary,
	SkillsResponse,
	SkillValidation,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import type { MintedPrincipal } from "../support/principal.js";

const json = { "content-type": "application/json" };

async function createSkill(
	t: TestApp,
	me: MintedPrincipal,
	body: Record<string, unknown>,
): Promise<ReturnType<TestApp["app"]["inject"]>> {
	return t.app.inject({
		method: "POST",
		url: "/api/skills",
		headers: { ...me.headers, ...json },
		payload: body,
	});
}

const DESCRIPTION = "Extract text and tables from PDF files. Use when working with PDF documents.";

describe("skill write path", () => {
	it("[05-skills-and-tools#A.4] creates a skill directory from the basic template", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const res = await createSkill(t, me, { name: "PDF tools", description: DESCRIPTION });
			expect(res.statusCode).toBe(201);
			const created = res.json<SkillSummary>();
			expect(created.dirName).toBe("pdf-tools");
			expect(created.source).toBe("managed");
			const path = join(t.home, "skills", "pdf-tools", "SKILL.md");
			expect(readFileSync(path, "utf8")).toContain("name: PDF tools");
			expect(readFileSync(path, "utf8")).toContain(`description: ${DESCRIPTION}`);
		});
	});

	it("[05-skills-and-tools#A.4] seeds the script and reference templates with their extra files", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const script = await createSkill(t, me, {
				name: "runner",
				description: DESCRIPTION,
				template: "script",
			});
			expect(script.statusCode).toBe(201);
			expect(existsSync(join(t.home, "skills", "runner", "scripts", "run.sh"))).toBe(true);

			const reference = await createSkill(t, me, {
				name: "docs",
				description: DESCRIPTION,
				template: "reference",
			});
			expect(reference.statusCode).toBe(201);
			expect(existsSync(join(t.home, "skills", "docs", "references", "overview.md"))).toBe(true);

			const detail = await t.app.inject({
				method: "GET",
				url: `/api/skills/${reference.json<SkillSummary>().id}`,
				headers: me.headers,
			});
			expect(detail.json<SkillDetail>().files.map((f) => f.path)).toEqual([
				"SKILL.md",
				"references/overview.md",
			]);
		});
	});

	it("[05-skills-and-tools#B.5.5] refuses to save a skill without a description, naming the problem", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const res = await createSkill(t, me, { name: "nodesc", description: "  " });
			expect(res.statusCode).toBe(400);
			expect(res.json<{ error: { code: string; message: string } }>().error.code).toBe(
				"skill_invalid",
			);
			expect(res.json<{ error: { message: string } }>().error.message).toMatch(/description/i);
			expect(existsSync(join(t.home, "skills", "nodesc"))).toBe(false);
		});
	});

	it("[05-skills-and-tools#B.5.5] refuses a PATCH that would empty the description and leaves the file untouched", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const id = (
				await createSkill(t, me, { name: "keep", description: DESCRIPTION })
			).json<SkillSummary>().id;
			const path = join(t.home, "skills", "keep", "SKILL.md");
			const before = readFileSync(path, "utf8");

			const res = await t.app.inject({
				method: "PATCH",
				url: `/api/skills/${id}`,
				headers: { ...me.headers, ...json },
				payload: { description: "" },
			});
			expect(res.statusCode).toBe(400);
			expect(res.json<{ error: { code: string } }>().error.code).toBe("skill_invalid");
			expect(readFileSync(path, "utf8")).toBe(before);

			// raw mode is validated the same way
			const raw = await t.app.inject({
				method: "PATCH",
				url: `/api/skills/${id}`,
				headers: { ...me.headers, ...json },
				payload: { raw: "no frontmatter at all\n" },
			});
			expect(raw.statusCode).toBe(400);
			expect(readFileSync(path, "utf8")).toBe(before);
		});
	});

	it("[05-skills-and-tools#A.2] reports warnings without blocking the save", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const res = await createSkill(t, me, { name: "shorty", description: "Short." });
			expect(res.statusCode).toBe(201);
			const detail = await t.app.inject({
				method: "GET",
				url: `/api/skills/${res.json<SkillSummary>().id}`,
				headers: me.headers,
			});
			const validation = detail.json<SkillDetail>().validation;
			expect(validation.valid).toBe(true);
			expect(validation.warnings.map((w) => w.code)).toContain("description_length");
			expect(detail.json<SkillDetail>().warnings.length).toBeGreaterThan(0);
		});
	});

	it("[05-skills-and-tools#A.4] reads, writes and deletes files inside the skill directory", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const id = (
				await createSkill(t, me, { name: "files", description: DESCRIPTION })
			).json<SkillSummary>().id;

			const put = await t.app.inject({
				method: "PUT",
				url: `/api/skills/${id}/files/references/api.md`,
				headers: { ...me.headers, ...json },
				payload: { content: "# API\n" },
			});
			expect(put.statusCode).toBe(200);
			expect(readFileSync(join(t.home, "skills", "files", "references", "api.md"), "utf8")).toBe(
				"# API\n",
			);

			const get = await t.app.inject({
				method: "GET",
				url: `/api/skills/${id}/files/references/api.md`,
				headers: me.headers,
			});
			expect(get.json<SkillFileResponse>().content).toBe("# API\n");

			const del = await t.app.inject({
				method: "DELETE",
				url: `/api/skills/${id}/files/references/api.md`,
				headers: me.headers,
			});
			expect(del.statusCode).toBe(200);
			expect(existsSync(join(t.home, "skills", "files", "references", "api.md"))).toBe(false);

			// SKILL.md is never deletable through the file route
			const refuse = await t.app.inject({
				method: "DELETE",
				url: `/api/skills/${id}/files/SKILL.md`,
				headers: me.headers,
			});
			expect(refuse.statusCode).toBe(400);
			expect(existsSync(join(t.home, "skills", "files", "SKILL.md"))).toBe(true);
		});
	});

	it("[11-security#3] rejects path traversal and oversize content on the file routes", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const id = (
				await createSkill(t, me, { name: "guard", description: DESCRIPTION })
			).json<SkillSummary>().id;

			// Percent-encoded traversal survives the router, so the domain guard is what stops it.
			for (const path of ["%2e%2e%2fescape.md", "nested%2f%2e%2e%2f%2e%2e%2fescape.md"]) {
				const res = await t.app.inject({
					method: "PUT",
					url: `/api/skills/${id}/files/${path}`,
					headers: { ...me.headers, ...json },
					payload: { content: "x" },
				});
				expect(res.statusCode, path).toBe(400);
				expect(res.json<{ error: { code: string } }>().error.code, path).toBe("path_escape");
			}
			// A literal `../` never even routes (the URL is normalised first).
			for (const path of ["../escape.md", "/etc/passwd"]) {
				const res = await t.app.inject({
					method: "PUT",
					url: `/api/skills/${id}/files/${path}`,
					headers: { ...me.headers, ...json },
					payload: { content: "x" },
				});
				expect(res.statusCode, path).toBeGreaterThanOrEqual(400);
			}
			expect(existsSync(join(t.home, "skills", "escape.md"))).toBe(false);
			expect(existsSync(join(t.home, "escape.md"))).toBe(false);

			const big = await t.app.inject({
				method: "PUT",
				url: `/api/skills/${id}/files/big.md`,
				headers: { ...me.headers, ...json },
				payload: { content: "x".repeat(512 * 1024 + 1) },
			});
			expect(big.statusCode).toBe(400);
			expect(existsSync(join(t.home, "skills", "guard", "big.md"))).toBe(false);
		});
	});

	it("[05-skills-and-tools#A.5] deletes a managed skill into trash and names the profiles that lose it", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const skill = (
				await createSkill(t, me, { name: "doomed", description: DESCRIPTION })
			).json<SkillSummary>();
			const profile = await t.app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...me.headers, ...json },
				payload: { name: "Uses doomed", skillIds: [skill.id], toolNames: ["read"] },
			});
			expect(profile.statusCode).toBe(201);

			const listed = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			expect(
				listed.json<SkillsResponse>().items.find((s) => s.id === skill.id)!.usedByProfiles,
			).toBe(1);

			const res = await t.app.inject({
				method: "DELETE",
				url: `/api/skills/${skill.id}`,
				headers: me.headers,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json<DeleteSkillResponse>().affectedProfiles).toEqual(["Uses doomed"]);
			expect(existsSync(join(t.home, "skills", "doomed"))).toBe(false);
			const trashed = readdirSync(join(t.home, "trash", "skills"));
			expect(trashed.some((name) => name.startsWith("doomed-"))).toBe(true);

			const after = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			expect(after.json<SkillsResponse>().items.find((s) => s.id === skill.id)).toBeUndefined();
		});
	});

	it("[05-skills-and-tools#A.1] unregisters an external skill without touching its files", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const dir = join(t.home, "user-pi", "agent", "skills", "outside");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---\nname: outside\ndescription: ${DESCRIPTION}\n---\n\nBody.\n`,
			);

			const listed = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			const external = listed.json<SkillsResponse>().items.find((s) => s.name === "outside")!;
			expect(external.source).toBe("external");

			const edit = await t.app.inject({
				method: "PATCH",
				url: `/api/skills/${external.id}`,
				headers: { ...me.headers, ...json },
				payload: { body: "rewritten" },
			});
			expect(edit.statusCode).toBe(409);

			const res = await t.app.inject({
				method: "DELETE",
				url: `/api/skills/${external.id}`,
				headers: me.headers,
			});
			expect(res.statusCode).toBe(200);
			expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
		});
	});

	it("[05-skills-and-tools#A.3] rescans on demand and validates a skill on request", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const id = (
				await createSkill(t, me, { name: "rescan-me", description: DESCRIPTION })
			).json<SkillSummary>().id;

			// A hand edit outside piui: the validate route reports it without a restart.
			writeFileSync(
				join(t.home, "skills", "rescan-me", "SKILL.md"),
				`---\nname: rescan-me\ndescription: ${DESCRIPTION}\n---\n\nSee [ref](references/missing.md).\n`,
			);
			const validated = await t.app.inject({
				method: "POST",
				url: `/api/skills/${id}/validate`,
				headers: { ...me.headers, ...json },
				payload: {},
			});
			expect(validated.statusCode).toBe(200);
			const validation = validated.json<SkillValidation>();
			expect(validation.valid).toBe(true);
			expect(validation.warnings.map((w) => w.code)).toContain("reference_missing");

			mkdirSync(join(t.home, "skills", "planted"), { recursive: true });
			writeFileSync(
				join(t.home, "skills", "planted", "SKILL.md"),
				`---\nname: planted\ndescription: ${DESCRIPTION}\n---\n\nBody.\n`,
			);
			const rescan = await t.app.inject({
				method: "POST",
				url: "/api/skills/rescan",
				headers: { ...me.headers, ...json },
				payload: {},
			});
			expect(rescan.statusCode).toBe(200);
			expect(rescan.json<{ added: number }>().added).toBe(1);
		});
	});

	it("[18-multi-user#5] keeps POST /api/skills/rescan admin-only", async () => {
		await withTestApp(async (t) => {
			const guest = t.mint({ id: "bob", role: "user" });
			const res = await t.app.inject({
				method: "POST",
				url: "/api/skills/rescan",
				headers: { ...guest.headers, ...json },
				payload: {},
			});
			expect(res.statusCode).toBe(403);
		});
	});
});
