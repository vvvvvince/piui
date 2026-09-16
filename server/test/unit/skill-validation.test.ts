// spec/05-skills-and-tools.md §A.2 — the error/warning table, as a pure function.
import { describe, expect, it } from "vitest";
import {
	composeSkillMd,
	MAX_SKILL_DIR_BYTES,
	MAX_SKILL_DIR_FILES,
	MAX_SKILL_FILE_BYTES,
	skillDirName,
	splitSkillMd,
	validateSkill,
} from "../../src/skills/validate.js";

const valid = (extra = ""): string =>
	`---\nname: brave-search\ndescription: Web search and content extraction via the Brave API. Use for docs and facts.\n---\n\nDo the thing.\n${extra}`;

const codes = (result: { errors: { code: string }[] }) => result.errors.map((e) => e.code);

describe("skill validation", () => {
	it("[05-skills-and-tools#A.2] accepts a well-formed SKILL.md with no errors and no warnings", () => {
		const result = validateSkill({ source: valid(), dirName: "brave-search" });
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("[05-skills-and-tools#A.2] errors on missing or unparseable frontmatter", () => {
		expect(codes(validateSkill({ source: "# just a body\n", dirName: "x" }))).toContain(
			"frontmatter_missing",
		);
		expect(codes(validateSkill({ source: "---\nname: x\nbody\n", dirName: "x" }))).toContain(
			"frontmatter_missing",
		);
	});

	it("[05-skills-and-tools#B.5.5] errors on a missing or empty description, naming the problem", () => {
		const missing = validateSkill({ source: `---\nname: ok\n---\n\nBody.\n`, dirName: "ok" });
		expect(codes(missing)).toContain("description_missing");
		expect(missing.errors[0]!.message).toMatch(/description/i);
		expect(missing.valid).toBe(false);
		const empty = validateSkill({
			source: `---\nname: ok\ndescription:\n---\n\nBody.\n`,
			dirName: "ok",
		});
		expect(codes(empty)).toContain("description_missing");
	});

	it("[05-skills-and-tools#A.2] errors on a missing name, a bad name and an empty body", () => {
		expect(
			codes(
				validateSkill({
					source: `---\ndescription: Fine and long enough for a skill.\n---\n\nB.\n`,
					dirName: "x",
				}),
			),
		).toContain("name_missing");
		expect(
			codes(
				validateSkill({
					source: `---\nname: -bad/name\ndescription: Fine and long enough for a skill here.\n---\n\nB.\n`,
					dirName: "x",
				}),
			),
		).toContain("name_invalid");
		expect(
			codes(
				validateSkill({
					source: `---\nname: ok\ndescription: Fine and long enough for a skill here.\n---\n\n   \n`,
					dirName: "ok",
				}),
			),
		).toContain("body_empty");
	});

	it("[05-skills-and-tools#A.2] errors on an oversized file, directory or file count", () => {
		const big = validateSkill({
			source: valid(),
			dirName: "brave-search",
			files: [{ path: "SKILL.md", size: MAX_SKILL_FILE_BYTES + 1 }],
		});
		expect(codes(big)).toContain("file_too_large");

		const fat = validateSkill({
			source: valid(),
			dirName: "brave-search",
			files: [
				{ path: "SKILL.md", size: 10 },
				{ path: "blob.bin", size: MAX_SKILL_DIR_BYTES },
			],
		});
		expect(codes(fat)).toContain("dir_too_large");

		const many = validateSkill({
			source: valid(),
			dirName: "brave-search",
			files: Array.from({ length: MAX_SKILL_DIR_FILES + 1 }, (_, i) => ({
				path: `f${i}.md`,
				size: 1,
			})),
		});
		expect(codes(many)).toContain("dir_too_many_files");
	});

	it("[05-skills-and-tools#A.2] warns about name/dirName drift, description length and unknown keys", () => {
		const result = validateSkill({
			source: `---\nname: brave-search\ndescription: Short.\ncolour: blue\n---\n\nBody.\n`,
			dirName: "search",
		});
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
		const warnings = result.warnings.map((w) => w.code);
		expect(warnings).toContain("name_differs_from_dir");
		expect(warnings).toContain("description_length");
		expect(warnings).toContain("unknown_frontmatter_keys");
		expect(result.warnings.find((w) => w.code === "unknown_frontmatter_keys")!.message).toContain(
			"colour",
		);
		// pi's own optional keys are not "unknown"
		const known = validateSkill({
			source: `---\nname: ok\ndescription: ${"x".repeat(40)}\nlicense: MIT\nallowed-tools: read bash\n---\n\nBody.\n`,
			dirName: "ok",
		});
		expect(known.warnings).toEqual([]);
	});

	it("[05-skills-and-tools#A.2] warns about a referenced path that is not in the skill directory", () => {
		const result = validateSkill({
			source: `---\nname: ok\ndescription: ${"x".repeat(40)}\n---\n\nSee [ref](references/api.md) and run \`scripts/run.sh\`.\n`,
			dirName: "ok",
			files: [
				{ path: "SKILL.md", size: 10 },
				{ path: "scripts/run.sh", size: 10 },
			],
		});
		const missing = result.warnings.filter((w) => w.code === "reference_missing");
		expect(missing).toHaveLength(1);
		expect(missing[0]!.message).toContain("references/api.md");
	});

	it("[05-skills-and-tools#A.4] recomposes the file from the form and splits it back", () => {
		const composed = composeSkillMd({
			name: "brave-search",
			description: "Search: with a colon, and #hash",
			body: "# Body\n\nDo it.",
		});
		expect(composed.startsWith("---\nname: brave-search\n")).toBe(true);
		const parsed = splitSkillMd(composed);
		expect(parsed.name).toBe("brave-search");
		expect(parsed.description).toBe("Search: with a colon, and #hash");
		expect(parsed.body).toBe("# Body\n\nDo it.\n");
		expect(validateSkill({ source: composed, dirName: "brave-search" }).errors).toEqual([]);
	});

	it("[05-skills-and-tools#A.1] slugifies a name into a unique dirName", () => {
		expect(skillDirName("Brave Search!", [])).toBe("brave-search");
		expect(skillDirName("Brave Search", ["brave-search"])).toBe("brave-search-2");
		expect(skillDirName("Brave Search", ["brave-search", "brave-search-2"])).toBe("brave-search-3");
		expect(skillDirName("!!!", [])).toBe("skill");
		expect(skillDirName("x".repeat(200), [])).toHaveLength(64);
		expect(skillDirName("Brave Search", [])).toMatch(/^[a-z0-9][a-z0-9._-]{1,63}$/);
	});
});
