// The skills read path (plan/05 §1, spec/05-skills-and-tools.md §A.3): the filesystem is the
// source of truth, the `skills` table is a mirror. Full CRUD is M6.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Principal, SkillSummary } from "@piui/shared";
import type { AppContext } from "../context.js";
import type { SkillRow } from "../db/repositories/skills.js";

/** A resolved pi skill (spec/03-profiles.md §3) — structural, so nothing here imports pi. */
export interface PiSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: "custom";
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	unknownKeys: string[];
}

/** Minimal YAML: `key: value` pairs, which is all the Agent Skills standard puts here. */
export function parseFrontmatter(source: string): SkillFrontmatter | undefined {
	if (!source.startsWith("---")) return undefined;
	const end = source.indexOf("\n---", 3);
	if (end === -1) return undefined;
	const out: SkillFrontmatter = { unknownKeys: [] };
	for (const line of source.slice(4, end).split("\n")) {
		const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
		if (!match) continue;
		const [, key, rawValue] = match;
		const value = (rawValue ?? "").replace(/^["']|["']$/g, "").trim();
		if (key === "name") out.name = value;
		else if (key === "description") out.description = value;
		else out.unknownKeys.push(key!);
	}
	return out;
}

export class SkillCatalog {
	constructor(private readonly ctx: AppContext) {}

	/** Rescan on every read — cheap, and it keeps a hand-edited directory honest (§A.3). */
	scan(): void {
		const root = this.ctx.config.paths.skills;
		const seen = new Set<string>();
		let dirs: string[] = [];
		try {
			dirs = readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			return;
		}
		for (const dirName of dirs) {
			const file = join(root, dirName, "SKILL.md");
			let front: SkillFrontmatter | undefined;
			try {
				front = parseFrontmatter(readFileSync(file, "utf8"));
			} catch {
				continue;
			}
			// Unparseable frontmatter is an M6 *validation* concern; the M5 scan just skips it.
			if (!front?.name || !front.description) continue;
			const row = this.ctx.repos.skills.upsert({
				dirName,
				name: front.name,
				description: front.description,
				ownerId: this.ctx.repos.users.adminId(),
			});
			seen.add(row.id);
		}
		const missing = this.ctx.repos.skills
			.all()
			.filter((row) => row.source === "managed" && !seen.has(row.id))
			.map((row) => row.id);
		this.ctx.repos.skills.markMissing(missing);
	}

	list(principal: Principal): SkillSummary[] {
		this.scan();
		const usage = this.ctx.repos.skills.profileUsage();
		return this.ctx.repos.skills.list(principal).map((row) => ({
			...this.view(row),
			usedByProfiles: usage.get(row.id) ?? 0,
		}));
	}

	dirOf(row: SkillRow): string {
		return row.ext_path ?? join(this.ctx.config.paths.skills, row.dir_name);
	}

	view(row: SkillRow): SkillSummary {
		const dir = this.dirOf(row);
		const missing = !existsSync(join(dir, "SKILL.md"));
		return {
			id: row.id,
			dirName: row.dir_name,
			name: row.name,
			description: row.description,
			enabled: row.enabled === 1 && !missing,
			source: row.source as "managed" | "external",
			path: dir,
			warnings: [],
			...(missing ? { missing: true as const } : {}),
		};
	}

	/**
	 * spec/03-profiles.md §3 + §6: unknown, deleted or missing ids are dropped **with a
	 * warning**, never a 500 (acceptance 8.5).
	 */
	resolve(skillIds: readonly string[]): { skills: PiSkill[]; warnings: string[] } {
		this.scan();
		const skills: PiSkill[] = [];
		const warnings: string[] = [];
		for (const id of skillIds) {
			const row = this.ctx.repos.skills.getById(id);
			if (!row) {
				warnings.push(`A skill this profile selected was deleted and is no longer available.`);
				continue;
			}
			const dir = this.dirOf(row);
			const filePath = join(dir, "SKILL.md");
			if (!existsSync(filePath) || !statSync(dir).isDirectory()) {
				warnings.push(`Skill "${row.name}" is missing on disk and was not loaded.`);
				continue;
			}
			skills.push({
				name: row.name,
				description: row.description,
				filePath,
				baseDir: dir,
				source: "custom",
			});
		}
		return { skills, warnings };
	}
}
