// Structural invariants, enforced by grep from day one (plan/00-plan.md §1.3).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function listFiles(dir: string, ext = ".ts"): string[] {
	const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", dir], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return out
		.split("\n")
		.filter((f) => f.endsWith(ext))
		.map((f) => `${repoRoot}/${f}`);
}

const read = (f: string) => readFileSync(f, "utf8");

describe("documentation", () => {
	it("[18-multi-user#9.8] warns in the README that a piui account is shell-equivalent trust", () => {
		const readme = readFileSync(`${repoRoot}/README.md`, "utf8");
		expect(readme).toMatch(/shell[- ]equivalent trust/i);
		expect(readme).toMatch(/only to people you would give\s+a?\s*shell account/i);
		expect(readme).toMatch(/not a security boundary between users/i);
	});
});

describe("structural invariants", () => {
	it("[01-architecture#2.1] imports pi only under server/src/pi/**", () => {
		const offenders = listFiles("server/src")
			.filter((f) => !f.includes("/src/pi/"))
			.filter((f) => /from\s+"@earendil-works\//.test(read(f)));
		expect(offenders).toEqual([]);
	});

	it("[18-multi-user#9.7] issues no SQL against owned tables outside the repository layer", () => {
		const ownedTables = ["profiles", "workspaces", "skills", "http_tools", "conversations"];
		const pattern = new RegExp(
			`(db|database)\\.(prepare|exec)\\([^)]*\\b(from|into|update|join)\\s+(${ownedTables.join("|")})\\b`,
			"is",
		);
		const offenders = listFiles("server/src")
			.filter((f) => !f.includes("/db/repositories/"))
			.filter((f) => pattern.test(read(f)));
		expect(offenders).toEqual([]);
	});

	it("[06-auth#8.6] names StaticAuthProvider only in http/auth.ts and its wiring", () => {
		const offenders = listFiles("server/src")
			.filter((f) => !f.endsWith("/http/auth.ts") && !f.endsWith("/context.ts"))
			.filter((f) => /StaticAuthProvider/.test(read(f)));
		expect(offenders).toEqual([]);
	});

	it("[01-architecture#3.1] reads process.env only in config.ts", () => {
		const offenders = listFiles("server/src")
			.filter((f) => !f.endsWith("/src/config.ts"))
			.filter((f) => /process\.env/.test(read(f)));
		expect(offenders).toEqual([]);
	});
});
