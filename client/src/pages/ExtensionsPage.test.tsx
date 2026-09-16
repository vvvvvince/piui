// spec/16-extensions.md §§7.1, 7.3 — the management page: the review gate on a URL install,
// the broken-extension banner, and the in-app uninstall dialog.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionsPage } from "./ExtensionsPage.js";

const EXTENSIONS = {
	items: [
		{
			id: "e1",
			name: "deployer",
			source: "managed",
			origin: "paste",
			path: "/home/piui/extensions/deployer.ts",
			enabled: true,
			loadError: null,
			tools: ["deploy"],
			commands: ["deploy"],
			disabledInProfiles: 1,
			editable: true,
		},
		{
			id: "e2",
			name: "broken",
			source: "external",
			origin: "/user/.pi/agent/extensions/broken.ts",
			path: "/user/.pi/agent/extensions/broken.ts",
			enabled: true,
			loadError: "ParseError: Unexpected keyword 'this'.",
			tools: [],
			commands: [],
			disabledInProfiles: 0,
			editable: false,
		},
	],
	installEnabled: true,
};

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderPage(overrides: { installEnabled?: boolean } = {}) {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (url.endsWith("/api/extensions") && (init?.method ?? "GET") === "GET") {
				return jsonResponse({ ...EXTENSIONS, ...overrides });
			}
			if (url.endsWith("/api/extensions/fetch")) {
				return jsonResponse({
					name: "remote",
					source: "export default function (pi) {}",
					sha256: "a".repeat(64),
					bytes: 31,
				});
			}
			return jsonResponse({});
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<ExtensionsPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("ExtensionsPage", () => {
	it("[16-extensions#10.9] shows the fetched source and enables Install only after the review box", async () => {
		const calls = renderPage();
		await screen.findByTestId("extension-row-deployer");

		await userEvent.type(screen.getByTestId("extension-url"), "https://example.com/remote.ts");
		await userEvent.click(screen.getByTestId("extension-url-fetch"));

		// CodeMirror renders the source as DOM text since M7's UX pass, not as a textarea value.
		const source = await screen.findByTestId("extension-review-source");
		expect(source).toHaveTextContent("export default function (pi) {}");
		expect(screen.getByTestId("extension-review-install")).toHaveProperty("disabled", true);
		// nothing installed by the fetch
		expect(
			calls.some((call) => call.init?.method === "POST" && call.url.endsWith("/api/extensions")),
		).toBe(false);

		await userEvent.click(screen.getByTestId("extension-review-checkbox"));
		expect(screen.getByTestId("extension-review-install")).toHaveProperty("disabled", false);
		await userEvent.click(screen.getByTestId("extension-review-install"));
		await waitFor(() =>
			expect(
				calls.some((call) => call.init?.method === "POST" && call.url.endsWith("/api/extensions")),
			).toBe(true),
		);
	});

	it("[16-extensions#10.9] disables every mutation when the server refuses installs", async () => {
		renderPage({ installEnabled: false });
		await screen.findByTestId("extension-row-deployer");
		expect(screen.getByTestId("extensions-rescan")).toHaveProperty("disabled", true);
		expect(screen.getByTestId("extension-delete-deployer")).toHaveProperty("disabled", true);
		expect(screen.getByTestId("extension-enabled-deployer")).toHaveProperty("disabled", true);
		expect(screen.getByText(/PIUI_DISABLE_EXTENSION_INSTALL=1/)).toBeTruthy();
	});

	it("lists a broken extension with its load error and a banner", async () => {
		renderPage();
		await screen.findByTestId("extension-row-broken");
		expect(screen.getByTestId("extension-error-broken").textContent).toContain("ParseError");
		expect(screen.getByTestId("extensions-broken-banner").textContent).toContain("broken");
	});

	it("[16-extensions#10.8] confirms an uninstall in-app, listing what disappears", async () => {
		const confirmSpy = vi.spyOn(window, "confirm");
		const calls = renderPage();
		await screen.findByTestId("extension-row-deployer");
		await userEvent.click(screen.getByTestId("extension-delete-deployer"));

		const dialog = await screen.findByTestId("extension-delete-dialog");
		expect(dialog.textContent).toContain("deploy");
		expect(dialog.textContent).toContain("1 profile");
		expect(confirmSpy).not.toHaveBeenCalled();

		await userEvent.click(screen.getByTestId("extension-delete-confirm"));
		await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
	});
});
