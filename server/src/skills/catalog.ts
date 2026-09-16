// The skills read path (plan/05 §1, spec/05-skills-and-tools.md §A.3): the filesystem is the
// source of truth, the `skills` table is a mirror. Full CRUD is M6.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Principal, SkillSummary } from "@piui/shared";
import type { AppContext } from "../context.js";
import type { SkillRow } from "../db/repositories/skills.js";
import { parseFrontmatter, type SkillFrontmatter } from "./validate.js";

/** A resolved pi skill (spec/03-profiles.md §3) — structural, so nothing here imports pi. */
export interface PiSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: "custom";
}

export { parseFrontmatter, type SkillFrontmatter } from "./validate.js";

/** A discovery root: every subdirectory holding a SKILL.md becomes a catalog entry. */
interface SkillRoot {
	dir: string;
	source: "managed" | "external";
	location?: "user" | "project";
}

export class SkillCatalog {
	constructor(private readonly ctx: AppContext) {}

	/**
	 * spec/15-commands-and-input.md §3.2 — TUI-like discovery: the piui-managed folder plus
	 * `~/.pi/agent/skills`, `~/.agents/skills` and, for **trusted** workspaces only, their
	 * `.pi/skills` and `.agents/skills`. Discovered skills are registered, never auto-enabled.
	 */
	private roots(): SkillRoot[] {
		const userAgentDir = this.ctx.config.userAgentDir;
		const roots: SkillRoot[] = [
			{ dir: this.ctx.config.paths.skills, source: "managed" },
			{ dir: join(userAgentDir, "skills"), source: "external", location: "user" },
			// `~/.agents/skills` sits next to `~/.pi`, so it follows the redirected user agent dir.
			{
				dir: join(dirname(dirname(userAgentDir)), ".agents", "skills"),
				source: "external",
				location: "user",
			},
		];
		for (const workspace of this.ctx.repos.workspaces.allTrusted()) {
			roots.push(
				{ dir: join(workspace.path, ".pi", "skills"), source: "external", location: "project" },
				{ dir: join(workspace.path, ".agents", "skills"), source: "external", location: "project" },
			);
		}
		return roots;
	}

	/** Rescan on every read — cheap, and it keeps a hand-edited directory honest (§A.3). */
	scan(): void {
		const seen = new Set<string>();
		for (const root of this.roots()) {
			let dirs: string[] = [];
			try {
				dirs = readdirSync(root.dir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name);
			} catch {
				continue;
			}
			for (const dirName of dirs) {
				const dir = join(root.dir, dirName);
				let front: SkillFrontmatter | undefined;
				try {
					front = parseFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
				} catch {
					continue;
				}
				// Unparseable frontmatter is an M6 *validation* concern; the scan just skips it.
				if (!front?.name || !front.description) continue;
				const row = this.ctx.repos.skills.upsert({
					// Discovered skills key on their absolute path: two roots may hold the same name.
					dirName: root.source === "managed" ? dirName : dir,
					name: front.name,
					description: front.description,
					source: root.source,
					...(root.source === "external" ? { extPath: dir } : {}),
					ownerId: this.ctx.repos.users.adminId(),
				});
				if (!seen.has(row.id)) seen.add(row.id);
			}
		}
		// Anything not seen this pass lost its directory or its trust: disabled, never deleted.
		const missing = this.ctx.repos.skills
			.all()
			.filter((row) => !seen.has(row.id))
			.map((row) => row.id);
		this.ctx.repos.skills.markMissing(missing);
	}

	/** spec §3.2 — the ids "Include all discovered skills" activates. */
	discoveredSkillIds(): string[] {
		this.scan();
		return this.ctx.repos.skills
			.all()
			.filter((row) => row.source === "external" && row.enabled === 1)
			.map((row) => row.id);
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
		const location = row.ext_path
			? this.ctx.repos.workspaces.allTrusted().some((ws) => dir.startsWith(`${ws.path}/`))
				? ("project" as const)
				: ("user" as const)
			: undefined;
		return {
			id: row.id,
			dirName: basename(row.dir_name),
			...(location ? { location } : {}),
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
