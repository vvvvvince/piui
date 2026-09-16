// spec/15-commands-and-input.md §1.3 (typed command + "show expanded") and §4.3 (Alt+T/Alt+O).
import type { UiMessage } from "@piui/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HotkeysDialog } from "./HotkeysDialog.js";
import { MessageList } from "./MessageList.js";

const expanded = "Review https://example.com/pr/1 carefully.";

const messages: UiMessage[] = [
	{
		id: "m1",
		role: "user",
		blocks: [{ type: "text", id: "m1:0", text: expanded }],
		commandEcho: { typed: "/review https://example.com/pr/1", expandedChars: expanded.length },
		createdAt: "2026-02-21T10:00:00.000Z",
	},
	{
		id: "m2",
		role: "assistant",
		blocks: [
			{ type: "thinking", id: "m2:0", text: "pondering", collapsedByDefault: true },
			{
				type: "tool",
				id: "m2:1",
				toolCallId: "t1",
				name: "read",
				label: "read",
				args: { path: "a.ts" },
				state: "ok",
				output: "file body",
			},
		],
		createdAt: "2026-02-21T10:00:01.000Z",
	},
];

describe("command echo and collapse toggles", () => {
	it("[15-commands-and-input#6.2] renders the typed command with a show-expanded disclosure", async () => {
		const user = userEvent.setup();
		render(<MessageList messages={messages} />);

		const bubble = screen.getByText("/review https://example.com/pr/1").closest("article")!;
		expect(bubble.textContent).not.toContain("carefully");

		await user.click(screen.getByRole("button", { name: /show expanded/i }));
		// markdown may split the URL into a link, so compare on the rendered text
		expect(bubble.textContent).toContain("carefully.");
	});

	it("[15-commands-and-input#6.7] Alt+T and Alt+O collapse thinking and tool output", async () => {
		const user = userEvent.setup();
		render(<MessageList messages={messages} />);

		// thinking and tool output start collapsed
		expect(screen.queryByText("pondering")).toBeNull();
		await user.keyboard("{Alt>}t{/Alt}");
		expect(screen.getByText("pondering")).toBeTruthy();

		expect(screen.queryByText("file body")).toBeNull();
		await user.keyboard("{Alt>}o{/Alt}");
		expect(screen.getByText("file body")).toBeTruthy();
	});
});

describe("hotkeys dialog", () => {
	it("[15-commands-and-input#6.7] lists both the piui key and the pi TUI key it maps to", () => {
		render(<HotkeysDialog onClose={() => {}} />);
		const rows = screen.getAllByRole("row").map((row) => row.textContent ?? "");
		const thinking = rows.find((row) => /thinking/i.test(row) && /Alt\+T/.test(row))!;
		expect(thinking).toContain("Ctrl+T");
		const toolOutput = rows.find((row) => /tool output/i.test(row))!;
		expect(toolOutput).toContain("Alt+O");
		expect(toolOutput).toContain("Ctrl+O");
	});
});
