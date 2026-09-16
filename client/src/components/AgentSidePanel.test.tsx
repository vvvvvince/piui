// spec/08-agent-mode.md §3 — the Files · Tools · Profile · Memory · Usage side panel.
import type { ConversationDetail, UiMessage } from "@piui/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSidePanel } from "./AgentSidePanel.js";

const CONVERSATION = {
	id: "c1",
	title: "Agent run",
	mode: "agent",
	model: { provider: "fake", modelId: "fake-1" },
	thinkingLevel: "off",
	profile: { id: "p1", name: "Coding agent" },
	workspace: { id: "w1", name: "alpha", path: "/tmp/alpha" },
	webSearch: false,
	archived: false,
	isStreaming: false,
	lastMessageAt: null,
	tokensTotal: 0,
	costTotal: 0,
	createdAt: "2026-02-22T10:00:00Z",
	systemPromptPreview: "prompt",
	state: {
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		queued: { steering: 0, followUp: 0 },
		contextPercent: 12,
	},
	tools: [
		{
			name: "read",
			label: "Read file",
			description: "Read a file.",
			kind: "builtin_pi",
			enabled: true,
			selectableInProfile: true,
			dangerous: false,
			configurable: false,
		},
		{
			name: "bash",
			label: "Run shell command",
			description: "Run a shell command.",
			kind: "builtin_pi",
			enabled: true,
			selectableInProfile: true,
			dangerous: true,
			configurable: false,
		},
	],
} as unknown as ConversationDetail;

const message = (blocks: UiMessage["blocks"]): UiMessage => ({
	id: "m1",
	role: "assistant",
	blocks,
	createdAt: "2026-02-22T10:00:01Z",
	usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.003 },
});

function stubFetch(treeEntries: string[]) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			calls.push(String(url));
			const body = String(url).includes("/tree")
				? {
						path: "",
						entries: treeEntries.map((name) => ({
							name,
							kind: "file",
							size: 3,
							modifiedAt: "2026-02-22T10:00:00Z",
							hidden: false,
						})),
						truncated: false,
					}
				: String(url).includes("/memory")
					? {
							path: "/m.md",
							enabled: false,
							sizeBytes: 0,
							modifiedAt: null,
							content: "",
							truncated: false,
							injectedBytes: 0,
							noteCount: 0,
						}
					: String(url).includes("/git")
						? { available: false }
						: {
								id: "p1",
								name: "Coding agent",
								description: "",
								agentsMd: "Always answer in French.",
								agentsMdSize: 24,
								skillIds: [],
								toolNames: ["read", "bash"],
								memory: { enabled: false, path: null, sizeBytes: 0 },
								usedByConversations: 1,
								ownerId: "local",
								visibility: "private",
								isOwn: true,
								createdAt: "",
								updatedAt: "",
								resolvedTools: [],
								warnings: [],
							};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

function renderPanel(messages: UiMessage[], entries: string[] = ["README.md"]) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const calls = stubFetch(entries);
	const view = render(
		<QueryClientProvider client={client}>
			<AgentSidePanel conversation={CONVERSATION} messages={messages} doneCount={0} />
		</QueryClientProvider>,
	);
	return { view, calls, client };
}

afterEach(() => vi.unstubAllGlobals());

describe("AgentSidePanel", () => {
	it("[08-agent-mode#8.4] the Tools tab lists exactly the resolved tools, with danger badges", async () => {
		renderPanel([]);
		await userEvent.click(screen.getByRole("tab", { name: /tools/i }));
		const items = await screen.findAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("read");
		expect(items[1]).toHaveTextContent("bash");
		expect(items[1]).toHaveTextContent(/dangerous/i);
	});

	it("refetches the workspace tree when a write tool completes, not only on done", async () => {
		const { view, calls } = renderPanel([]);
		await screen.findByRole("button", { name: /README.md/ });
		const before = calls.filter((url) => url.includes("/tree")).length;

		view.rerender(
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				<AgentSidePanel
					conversation={CONVERSATION}
					messages={[
						message([
							{
								type: "tool",
								id: "b1",
								toolCallId: "t1",
								name: "write",
								label: "write",
								args: { path: "hello.js" },
								state: "ok",
							},
						]),
					]}
					doneCount={0}
				/>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(calls.filter((url) => url.includes("/tree")).length).toBeGreaterThan(before),
		);
	});

	it("marks files the run touched and shows the per-message usage breakdown", async () => {
		renderPanel(
			[
				message([
					{
						type: "tool",
						id: "b1",
						toolCallId: "t1",
						name: "write",
						label: "write",
						args: { path: "hello.js" },
						state: "ok",
					},
				]),
			],
			["README.md", "hello.js"],
		);
		const touched = await screen.findByTitle(/touched by this conversation/i);
		expect(touched).toHaveTextContent("hello.js");

		await userEvent.click(screen.getByRole("tab", { name: /usage/i }));
		expect(await screen.findByText(/30 tokens/)).toBeInTheDocument();
		expect(screen.getAllByText(/\$0.0030/).length).toBeGreaterThan(0);
	});
});
