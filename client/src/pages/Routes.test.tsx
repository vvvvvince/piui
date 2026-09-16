// spec/10-frontend.md §1 — every route in the table resolves, and an unknown path is a
// designed state, not react-router's raw error screen (spec §4).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, useRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../routes.js";

const ME = {
	user: { id: "local", username: "test", displayName: "Local user", roles: ["admin"] },
	stepUpValidUntil: null,
};

const SKILL = {
	id: "s1",
	dirName: "m7-demo",
	name: "m7-demo",
	description: "A demo skill.",
	enabled: true,
	source: "managed",
	path: "/tmp/skills/m7-demo",
	warnings: [],
	usedByProfiles: 0,
	files: [{ path: "SKILL.md", bytes: 42 }],
};

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url === "/api/auth/me") return Response.json(ME);
			if (url.startsWith("/api/skills/s1")) {
				return Response.json({
					...SKILL,
					skillMd: { name: "m7-demo", description: "A demo skill.", body: "# demo", raw: "---\n" },
					validation: { errors: [], warnings: [] },
					editable: true,
				});
			}
			if (url.startsWith("/api/skills")) return Response.json({ items: [SKILL] });
			if (url.startsWith("/api/profiles")) return Response.json({ items: [] });
			return Response.json({ items: [], nextCursor: null });
		}),
	);
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string): void {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	function AppRoutes(): JSX.Element | null {
		return useRoutes(routes);
	}
	render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[path]}>
				<AppRoutes />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("routes", () => {
	it("[10-frontend#1.1] resolves the deep links the route table promises", async () => {
		renderAt("/skills/s1");
		// The editor opens straight from the URL, rather than 404-ing on a reload.
		expect(await screen.findByTestId("skill-editor")).toBeInTheDocument();
	});

	it("[10-frontend#1.2] resolves /profiles/new without a 404", async () => {
		renderAt("/profiles/new");
		expect(await screen.findByTestId("profile-create")).toBeInTheDocument();
	});

	it("[10-frontend#4.9] renders a designed not-found state for an unknown path", async () => {
		renderAt("/nope/nope");
		const box = await screen.findByTestId("not-found");
		expect(box).toHaveTextContent(/not found/i);
		expect(within(box).getByRole("link", { name: /conversations/i })).toBeInTheDocument();
	});
});
