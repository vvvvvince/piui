// spec/09-api.md §8 (export, compact) and spec/10-frontend.md §§2,4 (UX states).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationPage } from "./ConversationPage.js";

const DETAIL = {
	id: "c1",
	title: "A chat",
	mode: "chat",
	model: { provider: "p", modelId: "m" },
	thinkingLevel: "off",
	webSearch: false,
	archived: false,
	isStreaming: false,
	lastMessageAt: null,
	tokensTotal: 10,
	costTotal: 0.01,
	createdAt: "2026-01-01T00:00:00.000Z",
	tools: [],
	systemPromptPreview: "",
	state: {
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		queued: { steering: 0, followUp: 0 },
		contextPercent: 82,
	},
};

class FakeEventSource {
	static last: FakeEventSource | undefined;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onopen: (() => void) | null = null;
	constructor(readonly url: string) {
		FakeEventSource.last = this;
	}
	emit(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
	}
	close(): void {}
}

const fetchMock = vi.fn();

function renderPage(): void {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={["/c/c1"]}>
				<Routes>
					<Route path="/c/:id" element={<ConversationPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	fetchMock.mockImplementation(async (url: string) => {
		if (url.startsWith("/api/conversations/c1/messages")) return Response.json({ messages: [] });
		if (url.startsWith("/api/conversations/c1/commands")) return Response.json({ items: [] });
		if (url.startsWith("/api/conversations/c1/compact")) {
			return Response.json({
				summary: "earlier turns summarized",
				tokensBefore: 40000,
				estimatedTokensAfter: 8000,
				cost: 0.002,
			});
		}
		if (url.startsWith("/api/conversations/c1")) return Response.json(DETAIL);
		if (url.startsWith("/api/meta")) {
			return Response.json({
				searchProvider: { id: "none", configured: false },
				workspaceRoots: [],
				limits: { maxUploadMb: 10, maxConcurrentRuns: 4, maxRunMinutes: 30 },
				platform: "linux",
			});
		}
		return Response.json({ items: [] });
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	fetchMock.mockReset();
});

describe("conversation header", () => {
	it("[09-api#8.5] offers Compact now above 70 % context and posts the request", async () => {
		renderPage();
		const button = await screen.findByTestId("compact-now");
		await userEvent.click(button);
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					(call) =>
						String(call[0]).endsWith("/compact") &&
						(call[1] as RequestInit | undefined)?.method === "POST",
				),
			).toBe(true),
		);
		expect(await screen.findByText(/Context compacted/i)).toBeInTheDocument();
	});

	it("[09-api#8.6] links the three export formats", async () => {
		renderPage();
		const menu = await screen.findByTestId("export-menu");
		expect(menu).toBeInTheDocument();
		for (const format of ["md", "json", "html"]) {
			const link = screen.getByTestId(`export-${format}`);
			expect(link).toHaveAttribute("href", `/api/conversations/c1/export?format=${format}`);
		}
	});
});
