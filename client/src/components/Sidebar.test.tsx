// spec/10-frontend.md §1 (sidebar with recent conversations) and spec/09-api.md §9 (the global
// channel keeps the badges live without polling).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../routes.js";

const ME = {
	user: { id: "local", username: "test", displayName: "Local user", roles: ["admin"] },
	stepUpValidUntil: null,
};

const CONVERSATIONS = {
	items: [
		{
			id: "c1",
			title: "First chat",
			mode: "chat",
			model: { provider: "p", modelId: "m" },
			thinkingLevel: "off",
			webSearch: false,
			archived: false,
			isStreaming: false,
			lastMessageAt: null,
			tokensTotal: 0,
			costTotal: 0,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	],
	nextCursor: null,
};

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onopen: (() => void) | null = null;
	closed = false;
	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	emit(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
	}
	close(): void {
		this.closed = true;
	}
}

function stubFetch(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url === "/api/auth/me") return Response.json(ME);
			if (url.startsWith("/api/conversations")) return Response.json(CONVERSATIONS);
			if (url === "/api/health") {
				return Response.json({
					ok: true,
					version: "0.1.0",
					piVersion: "0.85.1",
					defaultCredentials: false,
					container: false,
					insecureTransportOk: false,
				});
			}
			return Response.json({ items: [] });
		}),
	);
}

function renderApp(): void {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	function AppRoutes(): JSX.Element | null {
		return useRoutes(routes);
	}
	render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={["/conversations"]}>
				<AppRoutes />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	FakeEventSource.instances = [];
	vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	stubFetch();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("sidebar live badges", () => {
	it("[09-api#9.1] shows a running badge from conversation_state without refetching", async () => {
		renderApp();
		expect(await screen.findByTestId("sidebar-conversation-c1")).toBeInTheDocument();
		expect(screen.queryByTestId("sidebar-running-count")).not.toBeInTheDocument();

		const source = FakeEventSource.instances[0]!;
		source.emit({ type: "conversation_state", conversationId: "c1", isStreaming: true });
		expect(await screen.findByTestId("sidebar-running-count")).toHaveTextContent("1");

		source.emit({ type: "conversation_done", conversationId: "c1" });
		await waitFor(() =>
			expect(screen.queryByTestId("sidebar-running-count")).not.toBeInTheDocument(),
		);
	});

	it("[09-api#9.2] ignores conversations that are not in the list (M6's ephemeral test runs)", async () => {
		renderApp();
		await screen.findByTestId("sidebar-conversation-c1");
		FakeEventSource.instances[0]!.emit({
			type: "conversation_state",
			conversationId: "ephemeral-test-run",
			isStreaming: true,
		});
		// The badge must stay absent: give React a flush, then assert.
		await waitFor(() => expect(screen.getByTestId("sidebar-conversation-c1")).toBeInTheDocument());
		expect(screen.queryByTestId("sidebar-running-count")).not.toBeInTheDocument();
	});

	it("[09-api#9.3] renames a conversation in place on conversation_title", async () => {
		renderApp();
		await screen.findByTestId("sidebar-conversation-c1");
		FakeEventSource.instances[0]!.emit({
			type: "conversation_title",
			conversationId: "c1",
			title: "Renamed by the model",
		});
		await waitFor(() =>
			expect(screen.getByTestId("sidebar-conversation-c1")).toHaveTextContent(
				"Renamed by the model",
			),
		);
	});

	it("opens exactly one global EventSource per tab, shared by every consumer", async () => {
		renderApp();
		await screen.findByTestId("sidebar-conversation-c1");
		expect(FakeEventSource.instances.filter((s) => s.url === "/api/events")).toHaveLength(1);
	});
});
