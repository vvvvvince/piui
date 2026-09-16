// spec/05-skills-and-tools.md §§A.4, A.5 — the skills page: list, validation panel, delete dialog.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsPage } from "./SkillsPage.js";

const SKILL = {
	id: "s1",
	dirName: "pdf-tools",
	name: "pdf-tools",
	description: "Extract text from PDFs.",
	enabled: true,
	source: "managed" as const,
	path: "/home/me/.piui/skills/pdf-tools",
	files: [{ path: "SKILL.md", size: 120 }],
	warnings: ["The description is 24 characters."],
	usedByProfiles: 1,
};

const DETAIL = {
	...SKILL,
	skillMd: {
		name: "pdf-tools",
		description: "Extract text from PDFs.",
		body: "# pdf-tools\n",
		raw: "---\nname: pdf-tools\n---\n",
	},
	validation: {
		errors: [],
		warnings: [{ code: "description_length", message: "The description is 24 characters." }],
		valid: true,
	},
	editable: true,
};

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
	const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
	vi.stubGlobal("fetch", mock);
	return mock;
}

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<SkillsPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("SkillsPage", () => {
	it("[05-skills-and-tools#A.4] lists skills with source, file count, usage and warnings", async () => {
		stubFetch(() => jsonResponse({ items: [SKILL] }));
		renderPage();

		expect(await screen.findByTestId("skill-row-pdf-tools")).toBeInTheDocument();
		expect(screen.getByText(/managed/)).toBeInTheDocument();
		expect(screen.getByText("1 files")).toBeInTheDocument();
		expect(screen.getByText(/used by 1 profile/)).toBeInTheDocument();
		expect(screen.getByTestId("skill-warning-pdf-tools")).toBeInTheDocument();
	});

	it("[05-skills-and-tools#B.5.5] shows the server's refusal when a skill cannot be saved", async () => {
		stubFetch((url, init) => {
			if (url.includes("/api/skills") && init?.method === "POST") {
				return jsonResponse(
					{
						error: {
							code: "skill_invalid",
							message: "Frontmatter is missing `description`.",
						},
					},
					400,
				);
			}
			return jsonResponse({ items: [SKILL] });
		});
		renderPage();

		await userEvent.click(await screen.findByTestId("skill-new"));
		await userEvent.type(screen.getByTestId("new-skill-name"), "nodesc");
		await userEvent.click(screen.getByTestId("new-skill-create"));

		expect(await screen.findByTestId("new-skill-error")).toHaveTextContent(/description/i);
	});

	it("[05-skills-and-tools#A.5] names the affected profiles in the in-app delete dialog", async () => {
		stubFetch((url) => {
			if (url.includes("/api/profiles")) {
				return jsonResponse({
					items: [
						{ id: "p1", name: "Researcher", skillIds: ["s1"] },
						{ id: "p2", name: "Other", skillIds: [] },
					],
				});
			}
			if (url.includes("/api/skills/s1")) return jsonResponse(DETAIL);
			return jsonResponse({ items: [SKILL] });
		});
		renderPage();

		await userEvent.click(await screen.findByTestId("skill-delete-pdf-tools"));
		const dialog = await screen.findByTestId("skill-delete-dialog");
		expect(dialog).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByTestId("skill-delete-affected")).toHaveTextContent("Researcher"),
		);
		expect(screen.getByTestId("skill-delete-affected")).not.toHaveTextContent("Other");
		// Never window.confirm: the dialog is in-app (spec/10-frontend.md, M2 decision).
		expect(screen.getByTestId("skill-delete-confirm")).toBeInTheDocument();
	});

	it("[05-skills-and-tools#B.5.5] shows a refused save next to the Save button, not only at the page top", async () => {
		stubFetch((url, init) => {
			if (url.includes("/api/skills/s1") && init?.method === "PATCH") {
				return jsonResponse(
					{ error: { code: "skill_invalid", message: "Frontmatter is missing `description`." } },
					400,
				);
			}
			if (url.includes("/api/skills/s1")) return jsonResponse(DETAIL);
			return jsonResponse({ items: [SKILL] });
		});
		renderPage();

		await userEvent.click(await screen.findByTestId("skill-open-pdf-tools"));
		await userEvent.clear(await screen.findByTestId("skill-description"));
		await userEvent.click(screen.getByTestId("skill-save"));
		expect(await screen.findByTestId("skill-save-error")).toHaveTextContent(/description/i);
	});

	it("[05-skills-and-tools#A.2] renders the validation panel of the opened skill", async () => {
		stubFetch((url) => {
			if (url.includes("/api/skills/s1")) return jsonResponse(DETAIL);
			return jsonResponse({ items: [SKILL] });
		});
		renderPage();

		await userEvent.click(await screen.findByTestId("skill-open-pdf-tools"));
		const panel = await screen.findByTestId("skill-validation");
		expect(panel).toHaveTextContent("The description is 24 characters.");
		expect(await screen.findByTestId("skill-file-SKILL.md")).toBeInTheDocument();
	});
});
