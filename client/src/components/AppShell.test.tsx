import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, useRoutes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "../routes.js";

const ME = {
	user: { id: "local", username: "test", displayName: "Local user", roles: ["admin"] },
	stepUpValidUntil: null,
};

/** Authenticated by default: the shell only renders behind AuthGate (spec/06-auth.md §6). */
function stubFetch(health: () => Promise<Response>) {
	const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
		if (url === "/api/auth/me") {
			return new Response(JSON.stringify(ME), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return health();
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function AppRoutes(): JSX.Element | null {
	return useRoutes(routes);
}

function renderApp(initialEntry = "/") {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[initialEntry]}>
				<AppRoutes />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("app shell", () => {
	it("renders the sidebar with every top-level section", async () => {
		stubFetch(() => Promise.reject(new Error("offline")));
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
		const fetchMock = stubFetch(async () =>
			Response.json({
				ok: true,
				version: "0.1.0",
				piVersion: "0.85.1",
				defaultCredentials: true,
				container: true,
				insecureTransportOk: true,
			}),
		);
		renderApp();
		expect(await screen.findByText(/v0\.1\.0 · pi 0\.85\.1 · container/)).toBeInTheDocument();
		const healthCall = fetchMock.mock.calls.find((c) => c[0] === "/api/health");
		expect(healthCall).toBeDefined();
		expect(healthCall![1]?.headers).toMatchObject({
			"X-Requested-With": "piui",
		});
	});

	it("routes to a placeholder page per section", async () => {
		stubFetch(() => Promise.reject(new Error("offline")));
		// /workspaces became real in M4 and /profiles in M5; /skills is still a placeholder.
		renderApp("/skills");
		expect(await screen.findByRole("heading", { name: "Skills" })).toBeInTheDocument();
		expect(screen.getByText(/arrives in milestone M6/)).toBeInTheDocument();
	});
});
