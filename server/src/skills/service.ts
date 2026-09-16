// The skill write path: create, edit, per-file routes, import, delete, rescan and the test run.
// spec/05-skills-and-tools.md §§A.2-A.5, spec/09-api.md §6.
//
// The filesystem stays the source of truth (M5b's discovery is untouched); this module is the
// only writer, and it validates *before* it writes, like M5c's extension install probe.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	CreateSkillRequest,
	DeleteSkillResponse,
	PatchSkillRequest,
	Principal,
	SkillDetail,
	SkillFileEntry,
	SkillRescanResponse,
	SkillSummary,
	SkillTemplate,
	SkillValidation,
} from "@piui/shared";
import type { AppContext } from "../context.js";
import type { SkillRow } from "../db/repositories/skills.js";
import { ApiError } from "../http/errors.js";
import type { SkillCatalog } from "./catalog.js";
import {
	composeSkillMd,
	MAX_SKILL_EDIT_BYTES,
	skillDirName,
	splitSkillMd,
	validateSkill,
} from "./validate.js";
import { readSkillZip } from "./zip.js";

export interface SkillServiceDeps {
	/** Emitted after anything changed, so open clients refetch (`skills_changed`). */
	onChanged?(): void;
}

export class SkillService {
	constructor(
		private readonly ctx: AppContext,
		private readonly catalog: SkillCatalog,
		private readonly deps: SkillServiceDeps = {},
	) {}

	// ------------------------------------------------------------- reading

	/**
	 * §A.2 — validation results are computed per request, not cached: it is one file read plus a
	 * readdir, and a cache keyed on `skills.updated_at` would go stale on every hand edit (the
	 * case the validation panel exists for). Same call the list makes for its warning icon.
	 */
	validate(row: SkillRow): SkillValidation {
		const dir = this.catalog.dirOf(row);
		const source = readIfPresent(join(dir, "SKILL.md"));
		if (source === undefined) {
			return {
				errors: [
					{ code: "missing", message: `${join(dir, "SKILL.md")} is gone; the skill cannot load.` },
				],
				warnings: [],
				valid: false,
			};
		}
		return validateSkill({
			source,
			dirName: row.dir_name.split(sep).pop() ?? row.dir_name,
			files: listFiles(dir),
		});
	}

	list(principal: Principal): SkillSummary[] {
		return this.catalog.list(principal).map((summary) => {
			const row = this.ctx.repos.skills.getById(summary.id);
			if (!row || summary.missing) return summary;
			const validation = this.validate(row);
			return {
				...summary,
				files: listFiles(this.catalog.dirOf(row)),
				warnings: [...validation.errors, ...validation.warnings].map((issue) => issue.message),
			};
		});
	}

	detail(principal: Principal, id: string): SkillDetail {
		const row = this.rowOrThrow(principal, id);
		const dir = this.catalog.dirOf(row);
		const raw = readIfPresent(join(dir, "SKILL.md")) ?? "";
		const parsed = splitSkillMd(raw);
		const validation = this.validate(row);
		const summary = this.catalog.view(row);
		return {
			...summary,
			usedByProfiles: this.ctx.repos.skills.profileUsage().get(row.id) ?? 0,
			files: listFiles(dir).map((file) => ({ path: file.path, size: file.size })),
			skillMd: { name: parsed.name, description: parsed.description, body: parsed.body, raw },
			validation,
			warnings: [...validation.errors, ...validation.warnings].map((issue) => issue.message),
			editable: row.source === "managed",
		};
	}

	// ------------------------------------------------------------ mutation

	create(principal: Principal, body: CreateSkillRequest): SkillSummary {
		const dirName = skillDirName(body.name, this.takenDirNames());
		const template = body.template ?? "basic";
		const source = composeSkillMd({
			name: body.name.trim(),
			description: body.description.trim(),
			body: body.body?.trim() || templateBody(template, body.name.trim()),
		});
		const extra = templateFiles(template);
		this.assertValid(
			validateSkill({
				source,
				dirName,
				files: [
					{ path: "SKILL.md", size: Buffer.byteLength(source) },
					...extra.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content) })),
				],
			}),
		);

		const dir = join(this.ctx.config.paths.skills, dirName);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), source);
		for (const file of extra) {
			mkdirSync(dirname(join(dir, file.path)), { recursive: true });
			writeFileSync(join(dir, file.path), file.content, file.mode ? { mode: file.mode } : {});
		}
		const row = this.ctx.repos.skills.upsert({
			dirName,
			name: body.name.trim(),
			description: body.description.trim(),
			source: "managed",
			ownerId: principal.id,
		});
		this.deps.onChanged?.();
		return this.catalog.view(row);
	}

	patch(principal: Principal, id: string, body: PatchSkillRequest): SkillSummary {
		const row = this.rowOrThrow(principal, id);
		const touchesFile =
			body.name !== undefined ||
			body.description !== undefined ||
			body.body !== undefined ||
			body.raw !== undefined;
		if (touchesFile) {
			this.requireManaged(row);
			const dir = this.catalog.dirOf(row);
			const current = splitSkillMd(readIfPresent(join(dir, "SKILL.md")) ?? "");
			// §A.4: the form is the source of truth; raw mode hands the whole file over instead.
			const source =
				body.raw !== undefined
					? body.raw
					: composeSkillMd({
							name: (body.name ?? current.name).trim(),
							description: (body.description ?? current.description).trim(),
							body: body.body ?? current.body,
						});
			const files = listFiles(dir).filter((file) => file.path !== "SKILL.md");
			this.assertValid(
				validateSkill({
					source,
					dirName: row.dir_name,
					files: [{ path: "SKILL.md", size: Buffer.byteLength(source) }, ...files],
				}),
			);
			writeFileSync(join(dir, "SKILL.md"), source);
			const parsed = splitSkillMd(source);
			this.ctx.repos.skills.upsert({
				dirName: row.dir_name,
				name: parsed.name,
				description: parsed.description,
				source: row.source as "managed" | "external",
				extPath: row.ext_path,
				ownerId: row.owner_id,
			});
		}
		if (body.enabled !== undefined) this.ctx.repos.skills.setEnabled(id, body.enabled);
		this.deps.onChanged?.();
		return this.catalog.view(this.ctx.repos.skills.getById(id)!);
	}

	remove(principal: Principal, id: string): DeleteSkillResponse {
		const row = this.rowOrThrow(principal, id);
		const affectedProfiles = this.ctx.repos.skills.profilesUsing(id);
		if (row.source === "managed") {
			// §A.5: a delete is a move to trash, never an unrecoverable rm.
			const trash = join(this.ctx.config.paths.trash, "skills");
			mkdirSync(trash, { recursive: true });
			const dir = this.catalog.dirOf(row);
			if (existsSync(dir)) {
				renameSync(dir, join(trash, `${row.dir_name}-${Date.now()}`));
			}
		}
		// External: the row goes, the user's files are never touched (§A.1).
		this.ctx.repos.skills.delete(id);
		this.deps.onChanged?.();
		return { affectedProfiles };
	}

	rescan(): SkillRescanResponse {
		const before = new Set(this.ctx.repos.skills.all().map((row) => row.id));
		this.catalog.scan();
		const after = this.ctx.repos.skills.all();
		const added = after.filter((row) => !before.has(row.id)).length;
		const missing = after.filter(
			(row) => !existsSync(join(this.catalog.dirOf(row), "SKILL.md")),
		).length;
		this.deps.onChanged?.();
		return { added, updated: after.length - added, missing };
	}

	// --------------------------------------------------------- file routes

	readFile(principal: Principal, id: string, relPath: string): { content: string; size: number } {
		const full = this.resolveInside(principal, id, relPath);
		if (!existsSync(full) || statSync(full).isDirectory()) {
			throw new ApiError("path_not_found", `${relPath} is not a file in this skill.`);
		}
		const size = statSync(full).size;
		if (size > MAX_SKILL_EDIT_BYTES) {
			throw new ApiError(
				"validation_error",
				`${relPath} is larger than 512 KB and is not editable here.`,
			);
		}
		const buffer = readFileSync(full);
		if (buffer.includes(0)) {
			throw new ApiError("binary_file", `${relPath} is binary and cannot be shown as text.`);
		}
		return { content: buffer.toString("utf8"), size };
	}

	writeFile(principal: Principal, id: string, relPath: string, content: string): SkillFileEntry {
		const row = this.rowOrThrow(principal, id);
		this.requireManaged(row);
		const full = this.resolveInside(principal, id, relPath);
		if (Buffer.byteLength(content) > MAX_SKILL_EDIT_BYTES) {
			throw new ApiError("validation_error", "A skill file is limited to 512 KB.");
		}
		if (relPath === "SKILL.md") {
			this.assertValid(validateSkill({ source: content, dirName: row.dir_name }));
		}
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
		this.deps.onChanged?.();
		return { path: relPath, size: Buffer.byteLength(content) };
	}

	deleteFile(principal: Principal, id: string, relPath: string): void {
		const row = this.rowOrThrow(principal, id);
		this.requireManaged(row);
		if (relPath === "SKILL.md") {
			throw new ApiError(
				"validation_error",
				"SKILL.md cannot be deleted; delete the skill instead.",
			);
		}
		const full = this.resolveInside(principal, id, relPath);
		rmSync(full, { recursive: true, force: true });
		this.deps.onChanged?.();
	}

	// ------------------------------------------------------------- import

	/** §A.4 option 3 — a pasted SKILL.md. */
	importSkillMd(principal: Principal, skillMd: string): SkillSummary {
		const parsed = splitSkillMd(skillMd);
		const dirName = skillDirName(parsed.name || "skill", this.takenDirNames());
		this.assertValid(
			validateSkill({
				source: skillMd,
				dirName,
				files: [{ path: "SKILL.md", size: Buffer.byteLength(skillMd) }],
			}),
		);
		const dir = join(this.ctx.config.paths.skills, dirName);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), skillMd);
		const row = this.ctx.repos.skills.upsert({
			dirName,
			name: parsed.name,
			description: parsed.description,
			source: "managed",
			ownerId: principal.id,
		});
		this.deps.onChanged?.();
		return this.catalog.view(row);
	}

	/** §A.4 option 2 — register an existing directory; it stays read-only and external. */
	importPath(principal: Principal, path: string): SkillSummary {
		if (!isAbsolute(path))
			throw new ApiError("path_not_absolute", `${path} is not an absolute path.`);
		const dir = resolve(path);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) {
			throw new ApiError("path_not_directory", `${path} is not a directory.`);
		}
		const source = readIfPresent(join(dir, "SKILL.md"));
		if (source === undefined) throw new ApiError("path_not_found", `${path} holds no SKILL.md.`);
		this.assertValid(
			validateSkill({ source, dirName: dir.split(sep).pop() ?? dir, files: listFiles(dir) }),
		);
		if (this.ctx.repos.skills.all().some((row) => row.ext_path === dir)) {
			throw new ApiError("path_already_registered", `${path} is already registered.`);
		}
		const parsed = splitSkillMd(source);
		const row = this.ctx.repos.skills.upsert({
			dirName: dir,
			name: parsed.name,
			description: parsed.description,
			source: "external",
			extPath: dir,
			ownerId: principal.id,
		});
		this.deps.onChanged?.();
		return this.catalog.view(row);
	}

	/** §A.4 option 1 — a `.zip`. Every hostile shape is refused before anything is written. */
	importZip(principal: Principal, archive: Buffer): SkillSummary {
		const entries = readSkillZip(archive);
		const skillMdEntry = entries.find((entry) => entry.path.endsWith("SKILL.md"));
		if (!skillMdEntry) {
			throw new ApiError("skill_invalid", "The archive holds no SKILL.md.");
		}
		// A one-directory archive (`my-skill/SKILL.md`) is unwrapped to its root.
		const prefix = skillMdEntry.path.slice(0, skillMdEntry.path.length - "SKILL.md".length);
		const files = entries
			.filter((entry) => entry.path.startsWith(prefix))
			.map((entry) => ({ path: entry.path.slice(prefix.length), content: entry.content }));
		const source = files.find((file) => file.path === "SKILL.md")!.content.toString("utf8");
		const parsed = splitSkillMd(source);
		const dirName = skillDirName(
			parsed.name || prefix.replace(/\/$/, "") || "skill",
			this.takenDirNames(),
		);
		this.assertValid(
			validateSkill({
				source,
				dirName,
				files: files.map((file) => ({ path: file.path, size: file.content.length })),
			}),
		);

		const dir = join(this.ctx.config.paths.skills, dirName);
		mkdirSync(dir, { recursive: true });
		for (const file of files) {
			const full = join(dir, file.path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, file.content);
		}
		const row = this.ctx.repos.skills.upsert({
			dirName,
			name: parsed.name,
			description: parsed.description,
			source: "managed",
			ownerId: principal.id,
		});
		this.deps.onChanged?.();
		return this.catalog.view(row);
	}

	// --------------------------------------------------------------- parts

	rowOrThrow(principal: Principal, id: string): SkillRow {
		const row = this.ctx.repos.skills.get(principal, id);
		if (!row) throw new ApiError("not_found", `No skill ${id}.`);
		return row;
	}

	private requireManaged(row: SkillRow): void {
		if (row.source !== "managed") {
			throw new ApiError(
				"skill_not_editable",
				"External skills are read-only in piui: edit them where they live, or unregister them.",
			);
		}
	}

	private assertValid(validation: SkillValidation): void {
		if (validation.valid) return;
		throw new ApiError(
			"skill_invalid",
			validation.errors.map((issue) => issue.message).join(" "),
			validation.errors.map((issue) => ({ path: issue.code, message: issue.message })),
		);
	}

	/** The traversal guard for `…/files/*`: the resolved path must stay inside the skill dir. */
	private resolveInside(principal: Principal, id: string, relPath: string): string {
		const row = this.rowOrThrow(principal, id);
		const dir = resolve(this.catalog.dirOf(row));
		const clean = relPath.replace(/^\/+/, "");
		if (clean.length === 0) throw new ApiError("path_escape", "No file named.");
		const full = resolve(dir, clean);
		const rel = relative(dir, full);
		if (isAbsolute(relPath) || rel.startsWith("..") || isAbsolute(rel) || rel.length === 0) {
			throw new ApiError("path_escape", `${relPath} is outside the skill directory.`);
		}
		return full;
	}

	private takenDirNames(): string[] {
		const onDisk = (() => {
			try {
				return readdirSync(this.ctx.config.paths.skills, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name);
			} catch {
				return [];
			}
		})();
		return [...new Set([...onDisk, ...this.ctx.repos.skills.all().map((row) => row.dir_name)])];
	}
}

function readIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Every file in the skill directory, relative POSIX paths, `SKILL.md` first. */
export function listFiles(dir: string): { path: string; size: number }[] {
	const out: { path: string; size: number }[] = [];
	const walk = (current: string, prefix: string): void => {
		let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(join(current, entry.name), rel);
			} else if (entry.isFile()) {
				out.push({ path: rel, size: statSync(join(current, entry.name)).size });
			}
		}
	};
	walk(dir, "");
	return out.sort((a, b) =>
		a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path),
	);
}

interface TemplateFile {
	path: string;
	content: string;
	mode?: number;
}

/** §A.4 — the three starters. */
function templateBody(template: SkillTemplate, name: string): string {
	if (template === "script") {
		return `# ${name}\n\n## Setup\n\nRun once before first use:\n\n\`\`\`bash\nchmod +x scripts/run.sh\n\`\`\`\n\n## Usage\n\nRun \`scripts/run.sh <input>\` and report what it prints.\n`;
	}
	if (template === "reference") {
		return `# ${name}\n\nStart here, then read only what you need:\n\n- [Overview](references/overview.md) — the concepts and the vocabulary.\n\nLoad a reference file with the read tool only when the task needs it.\n`;
	}
	return `# ${name}\n\n## When to use this\n\nDescribe the situation this skill is for.\n\n## Steps\n\n1. First step.\n2. Second step.\n`;
}

function templateFiles(template: SkillTemplate): TemplateFile[] {
	if (template === "script") {
		return [
			{
				path: "scripts/run.sh",
				content: `#!/bin/sh\n# Helper script for this skill. Arguments arrive as "$@".\nset -eu\necho "replace me: $*"\n`,
				mode: 0o755,
			},
		];
	}
	if (template === "reference") {
		return [
			{
				path: "references/overview.md",
				content: `# Overview\n\nDetailed reference material lives here, loaded on demand.\n`,
			},
		];
	}
	return [];
}
