// spec/03-profiles.md §5.3 — the memory_append tool: dated lines, dedupe, caps, per-profile
// mutex, and a visible notice on every successful append.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryTool } from "../../src/pi/tools/memory.js";
import { MEMORY_FILE_CAP, MemoryStore, parseMemory } from "../../src/profiles/memory.js";
import { withTempHome } from "../support/temp-home.js";

interface ToolLike {
	name: string;
	execute(
		id: string,
		params: { note: string; tags?: string[] },
	): Promise<{ content: { text?: string }[] }>;
}

function setup(home: string, notices: string[]) {
	const path = join(home, "profiles", "p1", "memory.md");
	const tool = createMemoryTool({
		profileId: "p1",
		profileName: "Coding agent",
		path,
		store: new MemoryStore(),
		nowIso: () => "2025-01-31T14:05:00.000Z",
		onNotice: (text) => notices.push(text),
	}) as unknown as ToolLike;
	return { tool, path };
}

const textOf = (result: { content: { text?: string }[] }): string =>
	result.content.map((c) => c.text ?? "").join("");

describe("memory_append", () => {
	it("creates the skeleton on first write and appends a dated line under ## Notes", async () => {
		await withTempHome(async ({ home }) => {
			const notices: string[] = [];
			const { tool, path } = setup(home, notices);
			const result = await tool.execute("call-1", {
				note: "The build uses pnpm, not npm.",
				tags: ["project", "style"],
			});
			expect(textOf(result)).toMatch(/remembered/i);

			const file = readFileSync(path, "utf8");
			expect(file).toContain("# Memory — Coding agent");
			expect(file).toContain("## Pinned");
			expect(file).toContain(
				"- [2025-01-31T14:05:00Z] (tags: project, style) The build uses pnpm, not npm.",
			);
			expect(notices).toEqual(["Remembered: The build uses pnpm, not npm."]);
		});
	});

	it("deduplicates case-insensitively without writing again", async () => {
		await withTempHome(async ({ home }) => {
			const notices: string[] = [];
			const { tool, path } = setup(home, notices);
			await tool.execute("a", { note: "Prefers terse answers." });
			const before = readFileSync(path, "utf8");
			const again = await tool.execute("b", { note: "  prefers TERSE answers.  " });
			expect(textOf(again)).toMatch(/already remembered/i);
			expect(readFileSync(path, "utf8")).toBe(before);
			expect(notices).toHaveLength(1);
		});
	});

	it("refuses a note over 2000 characters and a file over 1 MB with a tool error", async () => {
		await withTempHome(async ({ home }) => {
			const { tool, path } = setup(home, []);
			// pi turns a thrown error into an isError tool result (spike plan/spikes/09).
			await expect(tool.execute("a", { note: "x".repeat(2001) })).rejects.toThrow(/concise/i);

			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `## Notes\n\n${"y".repeat(MEMORY_FILE_CAP)}`);
			await expect(tool.execute("b", { note: "another note" })).rejects.toThrow(
				/curate|too large/i,
			);
		});
	});

	it("serializes concurrent appends per profile so none is lost", async () => {
		await withTempHome(async ({ home }) => {
			const { tool, path } = setup(home, []);
			await Promise.all(
				Array.from({ length: 20 }, (_, i) => tool.execute(`c${i}`, { note: `note number ${i}` })),
			);
			const notes = parseMemory(readFileSync(path, "utf8")).sections.find(
				(s) => s.name === "Notes",
			)!.notes;
			expect(notes).toHaveLength(20);
		});
	});
});
