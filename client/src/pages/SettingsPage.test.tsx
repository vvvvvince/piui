// spec/19-deployment.md §5/§9.8 — the deployment posture is rendered, never guesswork.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage.js";

const fetchMock = vi.fn();

function renderPage(): void {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<SettingsPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	fetchMock.mockImplementation(async (url: string) => {
		if (url.startsWith("/api/health")) {
			return Response.json({
				ok: true,
				version: "0.1.0",
				piVersion: "0.85.1",
				defaultCredentials: true,
				container: true,
				insecureTransportOk: true,
			});
		}
		if (url.startsWith("/api/meta")) {
			return Response.json({
				searchProvider: { id: "searxng", configured: true },
				workspaceRoots: ["/workspaces"],
				limits: { maxUploadMb: 10, maxConcurrentRuns: 4, maxRunMinutes: 30 },
				platform: "linux",
			});
		}
		return Response.json({ items: [], sources: [] });
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	fetchMock.mockReset();
});

describe("Settings → About", () => {
	it("[19-deployment#9.8] shows container and insecureTransportOk from /api/health", async () => {
		renderPage();
		const about = await screen.findByTestId("about-posture");
		await waitFor(() => expect(about).toHaveTextContent(/container:\s*yes/i));
		expect(about).toHaveTextContent(/plaintext acknowledged:\s*yes/i);
		expect(about).toHaveTextContent("0.85.1");
		// the default-credentials warning must be loud, since compose ships test/test
		expect(screen.getByTestId("about-default-credentials")).toBeInTheDocument();
	});
});
