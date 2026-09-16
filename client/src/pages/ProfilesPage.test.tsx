// spec/03-profiles.md §§2,4,5.4 — the profile list, the editor and the Memory panel.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfilesPage } from "./ProfilesPage.js";

const PROFILE = {
	id: "p1",
	name: "Coding agent",
	description: "Reads and writes code.",
	agentsMdSize: 42,
	skillIds: [],
	toolNames: ["read", "bash"],
	memory: { enabled: true, path: null, sizeBytes: 120 },
	usedByConversations: 2,
	ownerId: "local",
	visibility: "private",
	isOwn: true,
	createdAt: "2026-02-20T10:00:00Z",
	updatedAt: "2026-02-20T10:00:00Z",
};

const DETAIL = {
	...PROFILE,
	agentsMd: "Always answer in French.",
	resolvedTools: [
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
	],
	warnings: ['Skill "helper" is missing on disk and was not loaded.'],
};

const TOOLS = {
	items: [
		{
			name: "read",
			label: "Read file",
			description: "Read a file.",
			kind: "builtin_pi",
			enabled: true,
			selectableInProfile: true,
			dangerous: false,
			configurable: false,
			usedByProfiles: 1,
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
			usedByProfiles: 1,
		},
		{
			name: "memory_append",
			label: "Remember",
			description: "Append a note.",
			kind: "builtin_piui",
			enabled: true,
			selectableInProfile: false,
			dangerous: false,
			configurable: false,
			usedByProfiles: 0,
		},
	],
	webSearch: { provider: "none", configured: false },
};

const MEMORY = {
	path: "/home/u/.piui/profiles/p1/memory.md",
	enabled: true,
	sizeBytes: 65536,
	modifiedAt: "2026-02-21T09:00:00Z",
	content: "# Memory — Coding agent\n\n## Pinned\n\n## Notes\n\n- [t] pnpm not npm\n",
	truncated: true,
	injectedBytes: 32768,
	noteCount: 1,
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
	const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
	vi.stubGlobal("fetch", mock);
	return mock;
}

const ok = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<ProfilesPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("ProfilesPage", () => {
	it("lists profiles with their tools, memory state and conversation count", async () => {
		stubFetch((url) => {
			if (url.includes("/api/profiles/p1/memory")) return ok(MEMORY);
			if (url.includes("/api/profiles/p1")) return ok(DETAIL);
			if (url.includes("/api/profiles")) return ok({ items: [PROFILE] });
			if (url.includes("/api/skills")) return ok({ items: [] });
			return ok(TOOLS);
		});
		renderPage();
		expect(await screen.findByText("Coding agent")).toBeInTheDocument();
		expect(screen.getByText(/2 conversations/i)).toBeInTheDocument();
		expect(screen.getByText(/memory on/i)).toBeInTheDocument();
	});

	it("[17-memory#7.4] says plainly that pinned notes are not special yet, and what is injected", async () => {
		stubFetch((url) => {
			if (url.includes("/api/profiles/p1/memory")) return ok(MEMORY);
			if (url.includes("/api/profiles/p1")) return ok(DETAIL);
			if (url.includes("/api/profiles")) return ok({ items: [PROFILE] });
			if (url.includes("/api/skills")) return ok({ items: [] });
			return ok(TOOLS);
		});
		renderPage();
		await userEvent.click(await screen.findByRole("button", { name: /coding agent/i }));
		await userEvent.click(await screen.findByRole("tab", { name: /memory/i }));

		expect(
			await screen.findByText(/Pinned notes are always injected starting in a future version/i),
		).toBeInTheDocument();
		expect(screen.getByText(/injecting 32 KB of 64 KB/i)).toBeInTheDocument();
		expect(screen.getByText(/memory truncated/i)).toBeInTheDocument();
	});

	it("marks dangerous tools, hides memory_append from the selector, and shows resolution warnings", async () => {
		stubFetch((url) => {
			if (url.includes("/api/profiles/p1/memory")) return ok(MEMORY);
			if (url.includes("/api/profiles/p1")) return ok(DETAIL);
			if (url.includes("/api/profiles")) return ok({ items: [PROFILE] });
			if (url.includes("/api/skills")) return ok({ items: [] });
			return ok(TOOLS);
		});
		renderPage();
		await userEvent.click(await screen.findByRole("button", { name: /coding agent/i }));
		await userEvent.click(await screen.findByRole("tab", { name: /tools/i }));
		expect(await screen.findByLabelText(/Run shell command/i)).toBeInTheDocument();
		expect(screen.getByText(/dangerous/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/^Remember/i)).not.toBeInTheDocument();
		expect(screen.getByText(/missing on disk/i)).toBeInTheDocument();
	});

	it("confirms deletion in an in-app dialog (window.confirm is banned) and warns about conversations", async () => {
		const confirmSpy = vi.fn();
		vi.stubGlobal("confirm", confirmSpy);
		const fetchMock = stubFetch((url, init) => {
			if (init?.method === "DELETE") return ok({ affectedConversations: 2 });
			if (url.includes("/api/profiles/p1/memory")) return ok(MEMORY);
			if (url.includes("/api/profiles/p1")) return ok(DETAIL);
			if (url.includes("/api/profiles")) return ok({ items: [PROFILE] });
			if (url.includes("/api/skills")) return ok({ items: [] });
			return ok(TOOLS);
		});
		renderPage();
		await userEvent.click(await screen.findByRole("button", { name: /coding agent/i }));
		await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

		const dialog = await screen.findByRole("dialog", { name: /delete profile/i });
		expect(dialog).toHaveTextContent(/2 conversations/i);
		await userEvent.click(within(dialog).getByRole("button", { name: /delete profile/i }));

		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([url, init]) =>
						String(url).includes("/api/profiles/p1") &&
						(init as RequestInit | undefined)?.method === "DELETE",
				),
			).toBe(true),
		);
		expect(confirmSpy).not.toHaveBeenCalled();
	});
});

// spec/15-commands-and-input.md §3.2 — the "Include all discovered skills" convenience.
describe("discovered skills", () => {
	const discovered = {
		items: [
			{
				id: "s1",
				dirName: "tui-skill",
				name: "tui-skill",
				description: "A skill discovered in ~/.pi/agent/skills.",
				enabled: true,
				source: "external",
				location: "user",
				path: "/home/u/.pi/agent/skills/tui-skill",
				warnings: [],
				usedByProfiles: 0,
			},
		],
	};

	it("[15-commands-and-input#6.9] shows the discovered count with its context cost and patches the flag", async () => {
		const fetchMock = stubFetch((url) => {
			if (url.includes("/api/profiles/p1/memory")) return ok(MEMORY);
			if (url.includes("/api/profiles/p1"))
				return ok({ ...DETAIL, includeDiscoveredSkills: false });
			if (url.includes("/api/profiles")) return ok({ items: [PROFILE] });
			if (url.includes("/api/skills")) return ok(discovered);
			return ok(TOOLS);
		});
		renderPage();
		await userEvent.click(await screen.findByRole("button", { name: /coding agent/i }));
		await userEvent.click(await screen.findByRole("tab", { name: /^skills$/i }));

		expect(screen.getByText(/user/i)).toBeInTheDocument();
		const toggle = screen.getByLabelText(/include all discovered skills/i);
		expect(screen.getByText(/1 discovered skill/i).textContent).toMatch(/~\d+ tokens/);

		await userEvent.click(toggle);
		await waitFor(() => {
			const patch = fetchMock.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
			);
			expect(patch).toBeDefined();
			expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({
				includeDiscoveredSkills: true,
			});
		});
	});
});
