// "The suite runs offline, with no credentials" is itself an acceptance criterion.
// spec/20-development-method.md §9.1.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../server/test/support/temp-home.js";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function testFiles(): string[] {
	return execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts", "*.test.tsx"],
		{ cwd: repoRoot, encoding: "utf8" },
	)
		.split("\n")
		.filter(Boolean);
}

describe("test suite hygiene", () => {
	it("[20-development-method#9.1] runs with no provider credentials in the environment", () => {
		const leaked = Object.keys(process.env).filter((k) => /_API_KEY$|^ANTHROPIC_|^OPENAI_/.test(k));
		expect(leaked, "global setup must strip provider credentials").toEqual([]);
	});

	it("[20-development-method#9.1] gives every test an injected fetch that refuses real network I/O", async () => {
		await withTempHome(async ({ ctx }) => {
			expect(() => ctx.fetch("https://example.com" as never)).toThrow(/real network I\/O/);
		});
	});

	it("[20-development-method#9.1] contains no test that sleeps on a real timer instead of advancing the clock", () => {
		const offenders = testFiles().filter((file) => {
			const source = readFileSync(`${repoRoot}/${file}`, "utf8");
			return /await new Promise\(\s*\(?r\w*\)?\s*=>\s*setTimeout/.test(source);
		});
		expect(offenders, "use FakeClock.advance() instead of sleeping").toEqual([]);
	});
});
