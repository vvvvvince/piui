// The gate that makes the spec executable. spec/20-development-method.md §2 and §9.4.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectCriteria, collectTaggedTests } from "./spec-coverage.js";
import { COMPLETED_MILESTONES, exemptions, pending } from "./spec-exemptions.js";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const testFiles = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts", "*.test.tsx"],
	{ cwd: repoRoot, encoding: "utf8" },
)
	.split("\n")
	.filter(Boolean);

const criteria = collectCriteria(repoRoot);
const tagged = collectTaggedTests(repoRoot, testFiles);
const completed = new Set<string>(COMPLETED_MILESTONES);

const isDue = (milestones: string[]): boolean => milestones.some((m) => completed.has(m));

describe("spec coverage", () => {
	it("parses acceptance criteria out of the spec", () => {
		expect(criteria.length).toBeGreaterThan(50);
		expect(criteria.map((c) => c.tag)).toContain("20-development-method#9.1");
	});

	it("[20-development-method#9.4] every due acceptance criterion has a tagged test or a reasoned exemption", () => {
		const missing = criteria
			.filter((c) => isDue(c.milestones))
			.filter((c) => !tagged.has(c.tag))
			.filter((c) => exemptions[c.tag] === undefined)
			.filter((c) => pending[c.tag] === undefined)
			.map((c) => `${c.tag} — ${c.text}`);
		expect(missing, "untested acceptance criteria for completed milestones").toEqual([]);
	});

	it("keeps the pending list honest: nothing pending may belong to a completed milestone", () => {
		const stale = Object.entries(pending)
			.filter(([, milestone]) => completed.has(milestone))
			.map(([tag]) => tag);
		expect(stale).toEqual([]);
	});

	it("keeps the exemption list honest: every entry names a real criterion and gives a reason", () => {
		const known = new Set(criteria.map((c) => c.tag));
		const unknown = [...Object.keys(exemptions), ...Object.keys(pending)].filter(
			(t) => !known.has(t),
		);
		expect(unknown, "exemptions referencing criteria that no longer exist").toEqual([]);
		expect(Object.values(exemptions).filter((reason) => reason.trim().length < 10)).toEqual([]);
	});

	it("has no tagged test referring to a criterion that does not exist", () => {
		const known = new Set(criteria.map((c) => c.tag));
		const specIds = new Set(criteria.map((c) => c.specId));
		const bogus = [...tagged]
			// tags may also point at normative non-acceptance sections (e.g. [01-architecture#3.1])
			.filter((tag) => specIds.has(tag.split("#")[0]!))
			.filter((tag) => !known.has(tag))
			.filter((tag) => !tag.includes("#M"))
			.filter((tag) => Number(tag.split("#")[1]?.split(".")[0]) >= 6);
		expect(bogus).toEqual([]);
	});
});
