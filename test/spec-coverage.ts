// Parses the acceptance sections of spec/*.md into criterion ids: "<spec id>#<section>.<item>".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Criterion {
	tag: string;
	specId: string;
	section: string;
	item: number;
	milestones: string[];
	text: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const ACCEPTANCE = /acceptance/i;
const LIST_ITEM = /^(\d+)\.\s+(.*)$/;

export function specDir(repoRoot: string): string {
	return join(repoRoot, "spec");
}

export function parseFrontmatter(source: string): Record<string, string> {
	if (!source.startsWith("---")) return {};
	const end = source.indexOf("\n---", 3);
	if (end === -1) return {};
	const out: Record<string, string> = {};
	for (const line of source.slice(4, end).split("\n")) {
		const match = /^([a-z_]+):\s*(.*)$/.exec(line);
		if (match) out[match[1]!] = match[2]!.trim();
	}
	return out;
}

export function collectCriteria(repoRoot: string): Criterion[] {
	const dir = specDir(repoRoot);
	const criteria: Criterion[] = [];

	for (const file of readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()) {
		const source = readFileSync(join(dir, file), "utf8");
		const front = parseFrontmatter(source);
		const specId = front.id ?? file.replace(/\.md$/, "");
		if (specId === "spec-readme" || file === "README.md") continue;
		const milestones = (front.milestones ?? "")
			.replace(/[[\]]/g, "")
			.split(",")
			.map((m) => m.trim())
			.filter(Boolean);

		const lines = source.split("\n");
		let section: string | null = null;
		let inList = false;

		for (const line of lines) {
			const heading = HEADING.exec(line);
			if (heading) {
				const title = heading[2]!;
				if (ACCEPTANCE.test(title)) {
					// "## 9. Acceptance criteria" -> 9 ; "### B.5 Acceptance criteria" -> B.5
					const numbered = /^([A-Z]?\.?\d+(?:\.\d+)?|[A-Z]\.\d+)[.)]?\s/.exec(title);
					section = numbered ? numbered[1]!.replace(/\.$/, "") : title.trim();
				} else {
					section = null;
				}
				inList = false;
				continue;
			}
			if (section === null) continue;
			const item = LIST_ITEM.exec(line.trimEnd());
			if (item) {
				inList = true;
				criteria.push({
					tag: `${specId}#${section}.${item[1]}`,
					specId,
					section,
					item: Number(item[1]),
					milestones,
					text: item[2]!.replace(/\s+/g, " ").slice(0, 120),
				});
			} else if (inList && line.trim() === "") {
				// blank line inside a list is fine; keep going
			}
		}
	}
	return criteria;
}

/** Every `[spec-id#section.item]` tag appearing in a test name anywhere in the repo. */
export function collectTaggedTests(repoRoot: string, files: string[]): Set<string> {
	const tags = new Set<string>();
	const pattern = /\[([0-9a-z-]+#[A-Za-z0-9.]+)\]/g;
	for (const file of files) {
		const source = readFileSync(join(repoRoot, file), "utf8");
		for (const match of source.matchAll(pattern)) tags.add(match[1]!);
	}
	return tags;
}
