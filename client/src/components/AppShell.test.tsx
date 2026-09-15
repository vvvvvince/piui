import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "../routes.js";

function renderApp(initialEntry = "/") {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
	return render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("app shell", () => {
	it("renders the sidebar with every top-level section", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		renderApp();
		for (const label of [
			"Conversations",
			"Profiles",
			"Workspaces",
			"Skills",
			"Tools",
			"Settings",
		]) {
			expect(await screen.findByRole("link", { name: label })).toBeInTheDocument();
		}
	});

	it("shows the deployment posture returned by /api/health", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					version: "0.1.0",
					piVersion: "0.85.1",
					defaultCredentials: true,
					container: true,
					insecureTransportOk: true,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		renderApp();
		expect(await screen.findByText(/v0\.1\.0 · pi 0\.85\.1 · container/)).toBeInTheDocument();
		expect(fetchMock.mock.calls[0]![0]).toBe("/api/health");
		expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
			"X-Requested-With": "piui",
		});
	});

	it("routes to a placeholder page per section", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		renderApp("/workspaces");
		expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
		expect(screen.getByText(/arrives in milestone M4/)).toBeInTheDocument();
	});
});
