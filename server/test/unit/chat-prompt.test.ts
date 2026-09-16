// spec/07-chat-mode.md §§2, 4 — the fixed chat system prompt and the empty tool set.
import { describe, expect, it } from "vitest";
import { buildChatSystemPrompt, resolveChatTools } from "../../src/pi/resources.js";

describe("chat mode system prompt", () => {
	it("[07-chat-mode#4.1] never contains pi's coding-agent prompt and claims no filesystem", () => {
		const prompt = buildChatSystemPrompt({
			webSearch: false,
			date: "2026-02-20",
			timezone: "Europe/Paris",
		});
		expect(prompt).toContain("You are a helpful assistant answering questions in a web chat");
		expect(prompt).toContain("2026-02-20");
		expect(prompt).toContain("Europe/Paris");
		expect(prompt).toContain("no access to the user's files");
		for (const forbidden of ["AGENTS.md", "coding agent", "read the file", "workspace"]) {
			expect(prompt.toLowerCase()).not.toContain(forbidden.toLowerCase());
		}
	});

	it("[07-chat-mode#4.1] swaps the web-search block with the toggle and resolves zero tools", () => {
		const off = buildChatSystemPrompt({ webSearch: false, date: "2026-02-20", timezone: "UTC" });
		const on = buildChatSystemPrompt({ webSearch: true, date: "2026-02-20", timezone: "UTC" });
		expect(off).toContain("no web access in this conversation");
		expect(off).not.toContain("web_search");
		expect(on).toContain("`web_search`");
		expect(on).toContain("Sources");

		expect(resolveChatTools({ webSearch: false })).toEqual([]);
		// web tools land in M3; the toggle must still not add filesystem tools
		expect(resolveChatTools({ webSearch: true })).not.toContain("read");
	});
});
