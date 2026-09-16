// spec/07-chat-mode.md §3 — the web tool cards and the Sources footer.
import type { UiMessage } from "@piui/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList.js";

const searchMessage = (state: "running" | "ok" = "ok"): UiMessage => ({
	id: "m1",
	role: "assistant",
	createdAt: "2026-02-21T10:00:00.000Z",
	blocks: [
		{
			type: "tool",
			id: "m1:0",
			toolCallId: "c1",
			name: "web_search",
			label: "Web search",
			args: { query: "latest node lts" },
			state,
			output: "1. **Node.js releases** — Node 24 is LTS.\n   https://nodejs.org/en/about",
			details: {
				provider: "brave",
				query: "latest node lts",
				results: [
					{ title: "Node.js releases", url: "https://nodejs.org/en/about", snippet: "LTS" },
					{ title: "Release schedule", url: "https://github.com/nodejs/release", snippet: "wg" },
				],
			},
		},
		{ type: "text", id: "m1:1", text: "Node.js 24 is the active LTS." },
	],
});

const fetchMessage = (): UiMessage => ({
	id: "m2",
	role: "assistant",
	createdAt: "2026-02-21T10:00:01.000Z",
	blocks: [
		{
			type: "tool",
			id: "m2:0",
			toolCallId: "c2",
			name: "web_fetch",
			label: "Fetch web page",
			args: { url: "https://nodejs.org/en/about" },
			state: "ok",
			output: "# Releases",
			details: {
				url: "https://nodejs.org/en/about",
				finalUrl: "https://nodejs.org/en/about/previous-releases",
				status: 200,
				contentType: "text/html",
				chars: 11,
			},
		},
	],
});

describe("web tool cards", () => {
	it("[07-chat-mode#6.3] shows the query and result links, collapsed once complete", async () => {
		render(<MessageList messages={[searchMessage()]} />);

		// the card header carries the query without being expanded
		expect(screen.getByText(/latest node lts/)).toBeTruthy();
		// result titles are links
		const link = screen.getByRole("link", { name: "Node.js releases" });
		expect(link.getAttribute("href")).toBe("https://nodejs.org/en/about");
		// the raw tool output is hidden until the card is expanded
		expect(screen.queryByText(/1\. \*\*Node\.js releases\*\*/)).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: /web search/i }));
		expect(screen.getByText(/1\. \*\*Node\.js releases\*\*/)).toBeTruthy();
	});

	it("[07-chat-mode#6.3] renders a web_fetch card with final URL, status and char count", () => {
		render(<MessageList messages={[fetchMessage()]} />);
		expect(screen.getByText(/previous-releases/)).toBeTruthy();
		expect(screen.getByText(/200/)).toBeTruthy();
		expect(screen.getByText(/11 chars/)).toBeTruthy();
	});

	it("[07-chat-mode#6.3] shows a live 'searching…' card while the tool runs", () => {
		render(<MessageList messages={[searchMessage("running")]} />);
		expect(screen.getByText(/searching/i)).toBeTruthy();
	});
});

describe("Sources footer", () => {
	it("[07-chat-mode#6.3] lists one chip per domain the message used, even without citations", () => {
		render(<MessageList messages={[searchMessage(), fetchMessage()]} />);
		const footers = screen.getAllByRole("list", { name: /sources/i });
		expect(footers.length).toBe(2);

		const first = footers[0]!;
		const links = [...first.querySelectorAll("a")].map((a) => a.getAttribute("href"));
		expect(links).toEqual(["https://nodejs.org/en/about", "https://github.com/nodejs/release"]);
		expect(first.textContent).toContain("nodejs.org");
		expect(first.textContent).toContain("github.com");
	});

	it("[07-chat-mode#6.3] shows no footer for a message without web tools", () => {
		render(
			<MessageList
				messages={[
					{
						id: "m3",
						role: "assistant",
						createdAt: "2026-02-21T10:00:00.000Z",
						blocks: [{ type: "text", id: "m3:0", text: "plain answer" }],
					},
				]}
			/>,
		);
		expect(screen.queryByRole("list", { name: /sources/i })).toBeNull();
	});

	it("[07-chat-mode#6.3] deduplicates the same URL seen twice", () => {
		const message = searchMessage();
		render(
			<MessageList messages={[{ ...message, blocks: [...message.blocks, ...message.blocks] }]} />,
		);
		const list = screen.getByRole("list", { name: /sources/i });
		expect([...list.querySelectorAll("a")].length).toBe(2);
	});
});
