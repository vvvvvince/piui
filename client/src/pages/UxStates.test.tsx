// spec/10-frontend.md §4 — the UX states that must be designed, not improvised.
import type { UiMessage } from "@piui/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "../components/MessageList.js";
import { ConversationsPage } from "./ConversationsPage.js";

const fetchMock = vi.fn();

function renderWithQuery(ui: JSX.Element): void {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>{ui}</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	fetchMock.mockReset();
});

describe("UX states", () => {
	it("[10-frontend#4.1] offers the no-credentials setup card when no model is available", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.startsWith("/api/conversations")) {
				return Response.json({ items: [], nextCursor: null });
			}
			if (url.startsWith("/api/models")) {
				return Response.json({
					items: [{ provider: "anthropic", id: "claude", name: "Claude", available: false }],
					credentialsRevision: 1,
				});
			}
			return Response.json({ items: [] });
		});
		renderWithQuery(<ConversationsPage />);
		expect(await screen.findByTestId("no-credentials-card")).toHaveTextContent(
			/No model credentials found/i,
		);
		expect(screen.getByRole("link", { name: /Add a provider key/i })).toHaveAttribute(
			"href",
			"/settings/providers",
		);
	});

	it("[10-frontend#4.5] renders an error message with the provider text, Retry and copy details", () => {
		const messages: UiMessage[] = [
			{
				id: "m1",
				role: "error",
				blocks: [{ type: "text", id: "m1:0", text: "provider rejected the request: 429" }],
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const onRetry = vi.fn();
		render(<MessageList messages={messages} onRetry={onRetry} />);
		expect(screen.getByText(/provider rejected the request: 429/)).toBeInTheDocument();
		expect(screen.getByTestId("message-retry")).toBeInTheDocument();
		expect(screen.getByTestId("message-copy-details")).toBeInTheDocument();
	});

	it("[10-frontend#4.4] shows a working indicator while a tool runs", () => {
		const messages: UiMessage[] = [
			{
				id: "m1",
				role: "assistant",
				blocks: [
					{
						type: "tool",
						id: "m1:0",
						toolCallId: "t1",
						name: "bash",
						label: "bash",
						args: { command: "sleep 30" },
						state: "running",
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
				streaming: true,
			},
		];
		render(<MessageList messages={messages} />);
		expect(screen.getByTestId("working-indicator")).toHaveTextContent(/working/i);
	});
});
