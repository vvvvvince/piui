// spec/05-skills-and-tools.md §B.2 — the Configuration panel (web-search provider + Test
// search) and the catalog list with global enable/disable.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsPage } from "./ToolsPage.js";

const TOOLS = {
	items: [
		{
			name: "bash",
			label: "Run shell command",
			description: "Run a shell command.",
			kind: "builtin_pi",
			enabled: true,
			selectableInProfile: true,
			dangerous: true,
			configurable: false,
			usedByProfiles: 2,
		},
		{
			name: "web_search",
			label: "Web search",
			description: "Search the web.",
			kind: "builtin_piui",
			enabled: true,
			selectableInProfile: true,
			dangerous: false,
			configurable: true,
			usedByProfiles: 0,
		},
	],
	webSearch: { provider: "brave", configured: true },
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
	const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
	vi.stubGlobal("fetch", mock);
	return mock;
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<ToolsPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("ToolsPage", () => {
	it("[05-skills-and-tools#B.2] shows the provider status and the catalog grouped by kind", async () => {
		stubFetch(() => jsonResponse(TOOLS));
		renderPage();

		expect(await screen.findByText(/brave/i)).toBeTruthy();
		expect(screen.getByText(/key present/i).nextElementSibling?.textContent).toMatch(/yes/i);
		expect(await screen.findByText("bash")).toBeTruthy();
		expect(screen.getByText(/used by 2 profiles/i)).toBeTruthy();
		expect(screen.getAllByText(/dangerous/i).length).toBeGreaterThan(0);
	});

	it("[05-skills-and-tools#B.2] runs a test search and shows the top results", async () => {
		const calls: string[] = [];
		stubFetch((url) => {
			calls.push(url);
			if (url.includes("/tools/web_search/test")) {
				return jsonResponse({
					provider: "brave",
					results: [
						{ title: "Node releases", url: "https://nodejs.org", snippet: "LTS" },
						{ title: "Schedule", url: "https://github.com/nodejs/release", snippet: "wg" },
					],
				});
			}
			return jsonResponse(TOOLS);
		});
		renderPage();

		await screen.findByText("bash");
		await userEvent.type(screen.getByLabelText(/test query/i), "node lts");
		await userEvent.click(screen.getByRole("button", { name: /test search/i }));

		expect(await screen.findByText("Node releases")).toBeTruthy();
		expect(calls.some((url) => url.includes("/api/tools/web_search/test"))).toBe(true);
	});

	it("[05-skills-and-tools#B.2] explains a 503 instead of showing a broken page", async () => {
		stubFetch((url) => {
			if (url.includes("/tools/web_search/test")) {
				return jsonResponse(
					{
						error: { code: "provider_not_configured", message: "No web-search provider." },
					},
					503,
				);
			}
			return jsonResponse({ ...TOOLS, webSearch: { provider: "none", configured: false } });
		});
		renderPage();

		await screen.findByText("bash");
		await userEvent.click(screen.getByRole("button", { name: /test search/i }));
		expect(await screen.findByText(/no web-search provider/i)).toBeTruthy();
	});

	it("[05-skills-and-tools#B.2] toggles a tool globally through PATCH /api/tools/:name", async () => {
		const seen: { url: string; body: unknown }[] = [];
		stubFetch((url, init) => {
			if (init?.method === "PATCH") {
				seen.push({ url, body: JSON.parse(String(init.body)) });
				return jsonResponse({ ...TOOLS.items[0], enabled: false });
			}
			return jsonResponse(TOOLS);
		});
		renderPage();

		await screen.findByText("bash");
		const toggles = screen.getAllByRole("checkbox");
		await userEvent.click(toggles[0]!);

		await waitFor(() => expect(seen.length).toBe(1));
		expect(seen[0]!.url).toBe("/api/tools/bash");
		expect(seen[0]!.body).toEqual({ enabled: false });
	});
});
