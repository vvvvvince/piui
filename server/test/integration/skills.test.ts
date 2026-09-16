// M5's skills *read* path (plan/05 §1): scan $PIUI_HOME/skills/*/SKILL.md, mirror into the
// table, expose GET /api/skills. Full CRUD is M6 (05-skills-and-tools#B.5.{5,6}).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillSummary } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { withTestApp } from "../support/app.js";

function writeSkill(
	home: string,
	dir: string,
	frontmatter: string,
	body = "Do the thing.\n",
): void {
	const path = join(home, "skills", dir);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
}

describe("skills read path", () => {
	it("mirrors SKILL.md frontmatter into the catalog and reports usedByProfiles", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			writeSkill(t.home, "brave-search", "name: brave-search\ndescription: Search the web.");
			writeSkill(t.home, "pdf", "name: pdf\ndescription: Read PDFs.");

			const res = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			expect(res.statusCode).toBe(200);
			const items = res.json<{ items: SkillSummary[] }>().items;
			expect(items.map((s) => s.name).sort()).toEqual(["brave-search", "pdf"]);
			const brave = items.find((s) => s.name === "brave-search")!;
			expect(brave.description).toBe("Search the web.");
			expect(brave.source).toBe("managed");
			expect(brave.path).toBe(join(t.home, "skills", "brave-search"));
			expect(brave.usedByProfiles).toBe(0);
		});
	});

	it("flags a skill whose directory disappeared as missing instead of deleting the row", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			writeSkill(t.home, "gone", "name: gone\ndescription: Temporarily unmounted.");
			const first = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			const id = first.json<{ items: SkillSummary[] }>().items[0]!.id;

			rmSync(join(t.home, "skills", "gone"), { recursive: true, force: true });
			const second = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			const items = second.json<{ items: SkillSummary[] }>().items;
			expect(items).toHaveLength(1);
			expect(items[0]!.id).toBe(id);
			expect(items[0]!.missing).toBe(true);
			expect(items[0]!.enabled).toBe(false);
		});
	});

	it("skips a directory without parseable frontmatter rather than failing the scan", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			mkdirSync(join(t.home, "skills", "broken"), { recursive: true });
			writeFileSync(join(t.home, "skills", "broken", "SKILL.md"), "no frontmatter here\n");
			writeSkill(t.home, "good", "name: good\ndescription: Fine.");

			const res = await t.app.inject({ method: "GET", url: "/api/skills", headers: me.headers });
			expect(res.statusCode).toBe(200);
			expect(res.json<{ items: SkillSummary[] }>().items.map((s) => s.name)).toEqual(["good"]);
		});
	});
});
