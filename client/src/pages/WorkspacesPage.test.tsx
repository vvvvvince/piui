// spec/04-workspaces.md §§1,3,6,7 — the workspace UI: create/validate, the in-app delete
// confirmation, the Missing state, and the file browser that refetches after `done`.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacesPage } from "./WorkspacesPage.js";

const workspace = {
	id: "w1",
	name: "Demo",
	path: "/tmp/roots/demo",
	description: "a fixture",
	trusted: false,
	status: { exists: true, writable: true, isGitRepo: true, entryCount: 3 },
	activeConversations: 2,
	createdAt: "2026-02-20T10:00:00.000Z",
	updatedAt: "2026-02-20T10:00:00.000Z",
};

const missing = {
	...workspace,
	id: "w2",
	name: "Gone",
	path: "/tmp/roots/gone",
	status: { exists: false, writable: false, isGitRepo: false },
	activeConversations: 0,
};

class FakeEventSource {
	static last: FakeEventSource | undefined;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	constructor(readonly url: string) {
		FakeEventSource.last = this;
	}
	close(): void {}
	emit(payload: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
	}
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Route = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(route: Route) {
	const calls: { url: string; method: string; body?: unknown }[] = [];
	const mock = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
		});
		return route(url, init) ?? json({ items: [] });
	});
	vi.stubGlobal("fetch", mock);
	vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	return calls;
}

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<WorkspacesPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("WorkspacesPage", () => {
	it("[04-workspaces#1] lists workspaces with their status and concurrent-use warning", async () => {
		stubFetch((url) => (url.endsWith("/workspaces") ? json({ items: [workspace] }) : undefined));
		renderPage();

		expect(await screen.findByText("Demo")).toBeInTheDocument();
		expect(screen.getByText("/tmp/roots/demo")).toBeInTheDocument();
		expect(screen.getByText(/2 active conversations/i)).toBeInTheDocument();
		expect(screen.getByText(/git/i)).toBeInTheDocument();
	});

	it("[04-workspaces#7.1] shows the server's rejection instead of registering the folder", async () => {
		const calls = stubFetch((url, init) => {
			if (url.endsWith("/workspaces/validate")) {
				return json(
					{ error: { code: "path_denylisted", message: "/etc is a system folder." } },
					403,
				);
			}
			if (url.endsWith("/workspaces") && init?.method === "POST") {
				return json(
					{ error: { code: "path_denylisted", message: "/etc is a system folder." } },
					403,
				);
			}
			return undefined;
		});
		renderPage();
		await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
		await userEvent.type(screen.getByLabelText(/^name/i), "System");
		await userEvent.type(screen.getByLabelText(/^folder/i), "/etc");
		await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

		expect((await screen.findAllByText(/is a system folder/i)).length).toBeGreaterThan(0);
		expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/workspaces"))).toHaveLength(
			1,
		);
	});

	it("[04-workspaces#7.3] asks the server to create the folder and run git init", async () => {
		const calls = stubFetch((url, init) =>
			url.endsWith("/workspaces") && init?.method === "POST"
				? json({ ...workspace, name: "Fresh" }, 201)
				: undefined,
		);
		renderPage();
		await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
		await userEvent.type(screen.getByLabelText(/^name/i), "Fresh");
		await userEvent.type(screen.getByLabelText(/^folder/i), "/tmp/roots/fresh");
		await userEvent.click(screen.getByLabelText(/create the folder/i));
		await userEvent.click(screen.getByLabelText(/git init/i));
		await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

		await waitFor(() =>
			expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/workspaces"))?.body).toEqual(
				{
					name: "Fresh",
					path: "/tmp/roots/fresh",
					description: "",
					create: true,
					gitInit: true,
				},
			),
		);
	});

	it("[04-workspaces#7.6] confirms deletion in-app, promising the files stay, and never calls window.confirm", async () => {
		const confirm = vi.fn(() => true);
		vi.stubGlobal("confirm", confirm);
		const calls = stubFetch((_url, init) =>
			init?.method === "DELETE" ? json({ affectedConversations: 1 }) : json({ items: [workspace] }),
		);
		renderPage();

		await userEvent.click(await screen.findByRole("button", { name: /remove workspace/i }));
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByText(/folder and its files are left untouched/i),
		).toBeInTheDocument();
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);

		await userEvent.click(within(dialog).getByRole("button", { name: /remove/i }));
		await waitFor(() =>
			expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/workspaces/w1"))).toBe(
				true,
			),
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("[04-workspaces#7.5] marks a vanished folder Missing and says prompts are blocked", async () => {
		stubFetch((url) => (url.endsWith("/workspaces") ? json({ items: [missing] }) : undefined));
		renderPage();

		expect(await screen.findByText("Missing")).toBeInTheDocument();
		expect(screen.getByText(/new prompts are blocked/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /relocate/i })).toBeInTheDocument();
	});

	it("[04-workspaces#7.4] refetches the file tree when a run finishes, without a page reload", async () => {
		let treeReads = 0;
		stubFetch((url) => {
			if (url.endsWith("/workspaces")) return json({ items: [workspace] });
			if (url.includes("/tree")) {
				treeReads += 1;
				return json({
					path: "",
					truncated: false,
					entries:
						treeReads === 1
							? [
									{
										name: "README.md",
										kind: "file",
										size: 4,
										modifiedAt: "2026-02-20T10:00:00.000Z",
										hidden: false,
									},
								]
							: [
									{
										name: "README.md",
										kind: "file",
										size: 4,
										modifiedAt: "2026-02-20T10:00:00.000Z",
										hidden: false,
									},
									{
										name: "agent-wrote-this.md",
										kind: "file",
										size: 9,
										modifiedAt: "2026-02-20T10:05:00.000Z",
										hidden: false,
									},
								],
				});
			}
			if (url.includes("/git")) return json({ available: true, branch: "main", dirtyCount: 1 });
			return undefined;
		});
		renderPage();

		await userEvent.click(await screen.findByRole("button", { name: /files/i }));
		expect(await screen.findByRole("button", { name: /README\.md/ })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /agent-wrote-this/ })).not.toBeInTheDocument();
		expect(await screen.findByText(/main/)).toBeInTheDocument();

		FakeEventSource.last!.emit({ type: "conversation_done", conversationId: "c1" });
		expect(await screen.findByRole("button", { name: /agent-wrote-this/ })).toBeInTheDocument();
	});
});
