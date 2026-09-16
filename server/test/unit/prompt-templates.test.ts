// Prompt-template discovery and precedence (spec/15-commands-and-input.md §3.1).
// Pure: three directories in, one ordered list out. Argument substitution is pi's job and is
// asserted in server/test/integration/commands.test.ts against pi's output.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composePromptTemplates } from "../../src/pi/prompts.js";
import { createWorkspace } from "../support/workspace.js";

function plant(dir: string, name: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), content);
}

describe("prompt template composition", () => {
	it("[15-commands-and-input#6.1] reads description and argument-hint, and falls back to the first line", () => {
		const ws = createWorkspace({});
		try {
			plant(
				join(ws.path, "piui"),
				"review.md",
				"---\ndescription: Review a PR\nargument-hint: <PR-URL>\n---\n\nReview $1.\n",
			);
			plant(join(ws.path, "piui"), "plain.md", "Just do the thing, please.\n\nMore.\n");
			const composed = composePromptTemplates({ piuiDir: join(ws.path, "piui") });

			const review = composed.templates.find((t) => t.name === "review")!;
			expect(review.description).toBe("Review a PR");
			expect(review.argumentHint).toBe("<PR-URL>");
			expect(review.location).toBe("piui");
			expect(review.content.trim()).toBe("Review $1.");
			expect(composed.templates.find((t) => t.name === "plain")!.description).toBe(
				"Just do the thing, please.",
			);
		} finally {
			ws.cleanup();
		}
	});

	it("[15-commands-and-input#6.1] orders project over user over piui, and records the shadowing", () => {
		const ws = createWorkspace({});
		try {
			const dirs = {
				piuiDir: join(ws.path, "piui"),
				userDir: join(ws.path, "user"),
				projectDir: join(ws.path, "project"),
			};
			for (const [key, dir] of Object.entries(dirs)) {
				plant(dir, "both.md", `---\ndescription: from ${key}\n---\n\nBODY ${key}\n`);
			}
			plant(dirs.piuiDir, "only-piui.md", "piui only\n");

			const composed = composePromptTemplates(dirs);
			// pi expands with `templates.find(...)`: highest precedence must come first (spike S10).
			expect(composed.templates.map((t) => `${t.name}:${t.location}`)).toEqual([
				"both:project",
				"only-piui:piui",
			]);
			expect(composed.templates[0]!.shadows).toEqual(["user", "piui"]);
			expect(composed.sources.map((s) => s.count)).toEqual([2, 1, 1]);
		} finally {
			ws.cleanup();
		}
	});

	it("[15-commands-and-input#6.8] contributes nothing from an untrusted workspace", () => {
		const ws = createWorkspace({});
		try {
			plant(join(ws.path, ".pi", "prompts"), "component.md", "Create $1.\n");
			const untrusted = composePromptTemplates({ piuiDir: join(ws.path, "piui") });
			expect(untrusted.templates).toHaveLength(0);

			const trusted = composePromptTemplates({
				piuiDir: join(ws.path, "piui"),
				projectDir: join(ws.path, ".pi", "prompts"),
			});
			expect(trusted.templates.map((t) => t.name)).toEqual(["component"]);
		} finally {
			ws.cleanup();
		}
	});

	it("[15-commands-and-input#6.1] ignores non-markdown files and missing directories", () => {
		const ws = createWorkspace({});
		try {
			plant(join(ws.path, "piui"), "notes.txt", "not a template");
			mkdirSync(join(ws.path, "piui", "nested"), { recursive: true });
			writeFileSync(join(ws.path, "piui", "nested", "deep.md"), "not discovered, pi is flat");
			const composed = composePromptTemplates({
				piuiDir: join(ws.path, "piui"),
				userDir: join(ws.path, "does-not-exist"),
			});
			expect(composed.templates).toHaveLength(0);
		} finally {
			ws.cleanup();
		}
	});
});
