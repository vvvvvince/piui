// spec/05-skills-and-tools.md §B.2 — the HTTP-tool editor: schema builder, masked headers, Test.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpToolEditor } from "./HttpToolEditor.js";

const TOOL = {
	id: "t1",
	name: "weather",
	label: "Weather",
	description: "Look up the weather for a city.",
	enabled: true,
	method: "GET" as const,
	urlTemplate: "https://api.example.com/w?city={city}",
	headers: { authorization: "***" },
	bodyTemplate: null,
	parameters: [{ name: "city", type: "string" as const, required: true }],
	parametersSchema: { type: "object", properties: { city: { type: "string" } } },
	timeoutMs: 20000,
	usedByProfiles: 0,
};

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderEditor(tool?: typeof TOOL) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onSaved = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<HttpToolEditor {...(tool ? { tool } : {})} onSaved={onSaved} onCancel={() => undefined} />
		</QueryClientProvider>,
	);
	return { onSaved };
}

afterEach(() => vi.unstubAllGlobals());

describe("HttpToolEditor", () => {
	it("[05-skills-and-tools#B.2] shows a stored header value as *** and never reveals it", () => {
		renderEditor(TOOL);
		expect(screen.getByTestId("http-header-value-0")).toHaveValue("***");
		expect(document.body.textContent).not.toContain("Bearer");
	});

	it("[05-skills-and-tools#B.2] posts the form with the parameter rows the builder produced", async () => {
		const seen: { url: string; body: unknown }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
				return jsonResponse(TOOL, 201);
			}),
		);
		const { onSaved } = renderEditor();

		await userEvent.type(screen.getByTestId("http-tool-name"), "weather");
		await userEvent.type(
			screen.getByTestId("http-tool-description"),
			"Look up the weather for a city.",
		);
		await userEvent.clear(screen.getByTestId("http-tool-url"));
		await userEvent.type(
			screen.getByTestId("http-tool-url"),
			"https://api.example.com/w?city={city}",
		);
		await userEvent.click(screen.getByTestId("http-param-add"));
		await userEvent.type(screen.getByTestId("http-param-name-0"), "city");
		await userEvent.click(screen.getByTestId("http-param-required-0"));
		await userEvent.click(screen.getByTestId("http-tool-save"));

		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(seen[0]!.url).toBe("/api/tools/http");
		expect(seen[0]!.body).toMatchObject({
			name: "weather",
			method: "GET",
			parameters: [{ name: "city", type: "string", required: true }],
		});
	});

	it("[05-skills-and-tools#B.5.3] surfaces the SSRF refusal returned by the test endpoint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(
					{
						error: {
							code: "validation_error",
							message:
								"weather refused to call http://127.0.0.1:1234/: refusing to fetch a private address: 127.0.0.1",
						},
					},
					400,
				),
			),
		);
		renderEditor(TOOL);
		await userEvent.click(screen.getByTestId("http-tool-test"));
		expect(await screen.findByTestId("http-tool-error")).toHaveTextContent(/private address/i);
	});
});
