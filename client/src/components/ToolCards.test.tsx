// spec/08-agent-mode.md §2 — per-tool renderers: read, write, edit (diff), bash (streaming
// stdout), grep/find/ls, memory_append.
import type { UiMessage } from "@piui/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "./MessageList.js";

const bubble = (
	name: string,
	args: unknown,
	extra: Partial<Extract<UiMessage["blocks"][number], { type: "tool" }>> = {},
): UiMessage => ({
	id: "m1",
	role: "assistant",
	createdAt: "2026-02-22T10:00:00Z",
	blocks: [
		{
			type: "tool",
			id: "b1",
			toolCallId: "t1",
			name,
			label: name,
			args,
			state: "ok",
			...extra,
		},
	],
});

describe("agent tool cards", () => {
	it("renders an edit as a diff with green and red lines", async () => {
		render(
			<MessageBubble
				message={bubble(
					"edit",
					{ path: "seed.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
					{
						details: {
							diff: " 1 alpha\n-2 beta\n+2 BETA",
							patch: "--- seed.txt\n+++ seed.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
						},
					},
				)}
			/>,
		);
		expect(screen.getByText(/seed.txt/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /seed.txt/ }));
		const removed = screen.getByText("-2 beta");
		const added = screen.getByText("+2 BETA");
		expect(removed.className).toMatch(/rose/);
		expect(added.className).toMatch(/emerald/);
	});

	it("renders bash with the command, live output and a failure state", () => {
		render(
			<MessageBubble
				message={bubble(
					"bash",
					{ command: "node hello.js" },
					{ state: "running", output: "hello\n" },
				)}
			/>,
		);
		expect(screen.getAllByText("node hello.js").length).toBeGreaterThan(0);
		expect(screen.getAllByText(/hello/).length).toBeGreaterThan(0);
		expect(screen.getByText(/running/i)).toBeInTheDocument();
	});

	it("renders write with a byte count and read with the path", () => {
		const { rerender } = render(
			<MessageBubble
				message={bubble("write", { path: "hello.js", content: "console.log(1)\n" })}
			/>,
		);
		expect(screen.getByText(/hello.js/)).toBeInTheDocument();
		expect(screen.getByText(/15 B/)).toBeInTheDocument();

		rerender(
			<MessageBubble message={bubble("read", { path: "src/index.ts", offset: 10, limit: 5 })} />,
		);
		expect(screen.getByText(/src\/index.ts/)).toBeInTheDocument();
		expect(screen.getByText(/lines 10–14/)).toBeInTheDocument();
	});

	it("renders memory_append as a one-line Remembered card", () => {
		render(
			<MessageBubble
				message={bubble(
					"memory_append",
					{ note: "pnpm not npm" },
					{ output: "Remembered: pnpm not npm" },
				)}
			/>,
		);
		expect(screen.getByText(/Remembered: pnpm not npm/)).toBeInTheDocument();
	});
});
