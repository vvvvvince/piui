// Skill validation and the SKILL.md ⇄ form round trip. spec/05-skills-and-tools.md §§A.1, A.2.
// Pure: no filesystem, no db, no pi. The caller stats the directory and passes `files` in.
import type { SkillIssue, SkillValidation } from "@piui/shared";

export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_DIR_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_DIR_FILES = 500;
/** spec/09-api.md §6 — the per-file editor cap. */
export const MAX_SKILL_EDIT_BYTES = 512 * 1024;

/** §A.2: pi's name rule is stricter, but the spec's table is what piui enforces. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{1,63}$/;
const DIR_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Frontmatter keys pi documents (docs/skills.md); anything else is warned about. */
const KNOWN_KEYS = new Set([
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
	"disable-model-invocation",
]);

export interface SkillFileStat {
	/** Relative to the skill directory, POSIX separators. */
	path: string;
	size: number;
}

export interface ValidateSkillInput {
	source: string;
	dirName: string;
	/** The whole directory listing; omit when only the text matters. */
	files?: readonly SkillFileStat[];
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
		else if (!KNOWN_KEYS.has(key!)) out.unknownKeys.push(key!);
	}
	return out;
}

/** The body after the frontmatter block, normalised to end with exactly one newline. */
export function splitSkillMd(source: string): {
	name: string;
	description: string;
	body: string;
	unknownKeys: string[];
} {
	const front = parseFrontmatter(source);
	const end = source.startsWith("---") ? source.indexOf("\n---", 3) : -1;
	const body = end === -1 ? source : source.slice(end + 4).replace(/^[\r\n]+/, "");
	return {
		name: front?.name ?? "",
		description: front?.description ?? "",
		body: `${body.replace(/\s+$/, "")}\n`,
		unknownKeys: front?.unknownKeys ?? [],
	};
}

/**
 * §A.4: the form is the single source of truth, so the server recomposes the file rather than
 * letting the user hand-edit YAML into an unparseable state. Values are quoted when they could
 * break the one-line `key: value` shape.
 */
export function composeSkillMd(input: {
	name: string;
	description: string;
	body: string;
	/** Preserved verbatim, one `key: value` line each (raw mode round trip). */
	extraFrontmatter?: string;
}): string {
	const body = input.body.replace(/^\s+|\s+$/g, "");
	const extra = input.extraFrontmatter?.trim();
	return (
		`---\nname: ${yamlValue(input.name)}\ndescription: ${yamlValue(input.description)}\n` +
		`${extra ? `${extra}\n` : ""}---\n\n${body}\n`
	);
}

function yamlValue(value: string): string {
	const trimmed = value.trim();
	// A leading indicator or a trailing colon is what actually breaks the naive parse.
	return /^[>|&*!%@`'"[{-]|:\s|#\s/.test(trimmed) ? JSON.stringify(trimmed) : trimmed;
}

/** §A.1 — slugify a skill name into a unique directory name. */
export function skillDirName(name: string, taken: readonly string[]): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^[-._]+|[-._]+$/g, "")
			.slice(0, 64) || "skill";
	if (!taken.includes(base)) return base;
	for (let n = 2; ; n += 1) {
		const candidate = `${base.slice(0, 64 - String(n).length - 1)}-${n}`;
		if (!taken.includes(candidate)) return candidate;
	}
}

export function isValidDirName(dirName: string): boolean {
	return DIR_NAME_RE.test(dirName);
}

/** spec/05-skills-and-tools.md §A.2, the whole table. */
export function validateSkill(input: ValidateSkillInput): SkillValidation {
	const errors: SkillIssue[] = [];
	const warnings: SkillIssue[] = [];
	const front = parseFrontmatter(input.source);

	if (!front) {
		errors.push({
			code: "frontmatter_missing",
			message:
				"SKILL.md must start with YAML frontmatter delimited by --- lines holding `name` and `description`.",
		});
	} else {
		if (!front.name) {
			errors.push({ code: "name_missing", message: "Frontmatter is missing `name`." });
		} else if (!NAME_RE.test(front.name)) {
			errors.push({
				code: "name_invalid",
				message: `"${front.name}" is not a valid skill name: letters, digits, space, dot, dash or underscore, 2–64 characters, not starting with punctuation.`,
			});
		}
		if (!front.description) {
			errors.push({
				code: "description_missing",
				message:
					"Frontmatter is missing `description`. The description is what tells the model when to use this skill, so it cannot be empty.",
			});
		}
		if (front.unknownKeys.length > 0) {
			warnings.push({
				code: "unknown_frontmatter_keys",
				message: `Unknown frontmatter keys are ignored: ${front.unknownKeys.join(", ")}.`,
			});
		}
		if (front.name && front.name !== input.dirName) {
			warnings.push({
				code: "name_differs_from_dir",
				message: `The skill name "${front.name}" differs from its directory "${input.dirName}". pi allows it; other harnesses may not.`,
			});
		}
		const length = front.description?.length ?? 0;
		if (length > 0 && (length < 30 || length > 1024)) {
			warnings.push({
				code: "description_length",
				message:
					length < 30
						? `The description is ${length} characters. Say what the skill does *and* when to use it (30+ characters).`
						: `The description is ${length} characters; over 1024 it is likely to be truncated by other harnesses.`,
			});
		}
	}

	const body = splitSkillMd(input.source).body.trim();
	if (body.length === 0) {
		errors.push({
			code: "body_empty",
			message: "The skill body is empty: there are no instructions for the model to follow.",
		});
	}

	const files = input.files ?? [];
	const oversize = files.find((file) => file.size > MAX_SKILL_FILE_BYTES);
	if (oversize) {
		errors.push({
			code: "file_too_large",
			message: `${oversize.path} is larger than 1 MB; a skill file must stay under that.`,
		});
	}
	const total = files.reduce((sum, file) => sum + file.size, 0);
	if (total > MAX_SKILL_DIR_BYTES) {
		errors.push({
			code: "dir_too_large",
			message: `The skill directory is ${Math.round(total / 1024 / 1024)} MB; the limit is 50 MB.`,
		});
	}
	if (files.length > MAX_SKILL_DIR_FILES) {
		errors.push({
			code: "dir_too_many_files",
			message: `The skill directory holds ${files.length} files; the limit is ${MAX_SKILL_DIR_FILES}.`,
		});
	}

	if (input.files) {
		const present = new Set(files.map((file) => file.path));
		for (const reference of referencedPaths(input.source)) {
			if (present.has(reference)) continue;
			warnings.push({
				code: "reference_missing",
				message: `The body references ${reference}, which is not in the skill directory.`,
			});
		}
	}

	return { errors, warnings, valid: errors.length === 0 };
}

/** Best-effort (§A.2): relative links and `scripts/…`-looking paths in the body. */
export function referencedPaths(source: string): string[] {
	const found = new Set<string>();
	const patterns = [
		/\]\(\.?\/?([\w.-]+(?:\/[\w.-]+)+)\)/g, // [text](references/api.md)
		/`\.?\/?((?:scripts|references|assets)\/[\w.-]+(?:\/[\w.-]+)*)`/g, // `scripts/run.sh`
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const path = match[1]!;
			if (path.startsWith("http") || path.includes("://")) continue;
			found.add(path);
		}
	}
	return [...found];
}
