// Prompt-template discovery and composition (spec/15-commands-and-input.md §3.1).
//
// pi's own `loadPromptTemplates()` is not reachable (not exported from the package root, and
// the `exports` map blocks a deep import — spike plan/spikes/10), so piui scans the three
// directories with pi's rules: non-recursive, `*.md`, basename = command name, frontmatter
// `description` / `argument-hint`, description falling back to the first non-empty body line
// truncated at 60 chars. **Only discovery lives here** — `$1`/`$@` substitution stays pi's job.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptLocation = "piui" | "user" | "project";

/** Shaped like pi's `PromptTemplate`, plus piui's source badge. */
export interface PiuiPromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	filePath: string;
	location: PromptLocation;
	/** Lower-precedence sources this template hides (spec §3.1: shadowing must be visible). */
	shadows?: PromptLocation[];
}

export interface PromptDirs {
	piuiDir: string;
	userDir?: string | undefined;
	/** `<workspace>/.pi/prompts` — passed **only** for a trusted workspace (spec §3.3). */
	projectDir?: string | undefined;
}

export interface ComposedPrompts {
	/** Highest precedence first: pi expands with `templates.find(…)` (spike S10 §3). */
	templates: PiuiPromptTemplate[];
	sources: { location: PromptLocation; path: string; count: number }[];
}

const DESCRIPTION_LIMIT = 60;

function parseTemplate(
	filePath: string,
	name: string,
	location: PromptLocation,
): PiuiPromptTemplate | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const normalized = raw.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
	const end = normalized.startsWith("---") ? normalized.indexOf("\n---", 3) : -1;
	const front = end === -1 ? "" : normalized.slice(4, end);
	const content = end === -1 ? normalized : normalized.slice(end + 4).trim();

	const field = (key: string): string | undefined => {
		const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front);
		const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
		return value ? value : undefined;
	};

	let description = field("description");
	if (!description) {
		const firstLine = content.split("\n").find((line) => line.trim()) ?? "";
		description =
			firstLine.length > DESCRIPTION_LIMIT
				? `${firstLine.slice(0, DESCRIPTION_LIMIT)}...`
				: firstLine;
	}
	const argumentHint = field("argument-hint");
	return {
		name,
		description,
		...(argumentHint ? { argumentHint } : {}),
		content,
		filePath,
		location,
	};
}

function loadDir(dir: string | undefined, location: PromptLocation): PiuiPromptTemplate[] {
	if (!dir) return [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: PiuiPromptTemplate[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".md")) continue;
		const template = parseTemplate(join(dir, name), name.slice(0, -3), location);
		if (template) out.push(template);
	}
	return out;
}

/** Composes `$PIUI_HOME/prompts` < `~/.pi/agent/prompts` < trusted `<ws>/.pi/prompts`. */
export function composePromptTemplates(dirs: PromptDirs): ComposedPrompts {
	const byLocation: [PromptLocation, string | undefined][] = [
		["project", dirs.projectDir],
		["user", dirs.userDir],
		["piui", dirs.piuiDir],
	];
	const loaded = byLocation.map(([location, dir]) => ({
		location,
		path: dir ?? "",
		templates: loadDir(dir, location),
	}));

	const winners = new Map<string, PiuiPromptTemplate>();
	for (const source of loaded) {
		for (const template of source.templates) {
			const existing = winners.get(template.name);
			if (existing) existing.shadows = [...(existing.shadows ?? []), template.location];
			else winners.set(template.name, { ...template });
		}
	}
	return {
		templates: [...winners.values()],
		// Displayed in the spec's order (1 piui, 2 user, 3 project), i.e. increasing precedence.
		sources: [...loaded]
			.reverse()
			.filter((source) => source.path !== "")
			.map((source) => ({
				location: source.location,
				path: source.path,
				count: source.templates.length,
			})),
	};
}
