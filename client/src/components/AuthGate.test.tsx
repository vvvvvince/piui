// spec/06-auth.md §6 + spec/14-credentials.md §5 — login gate, 401 interceptor,
// step-up dialog and the single retry of the original request.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, request, setAuthHandlers } from "../api/client.js";
import { routes } from "../routes.js";

interface Route {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

function jsonResponse({ status, body }: Route): Response {
	if (status === 204) return new Response(null, { status });
	return new Response(JSON.stringify(body ?? {}), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const ADMIN_ME = {
	user: { id: "local", username: "test", displayName: "Local user", roles: ["admin"] },
	stepUpValidUntil: null,
};
const USER_ME = {
	user: { id: "bob", username: "bob", displayName: "Bob", roles: ["user"] },
	stepUpValidUntil: null,
};
const HEALTH = {
	ok: true,
	version: "0.1.0",
	piVersion: "0.85.1",
	defaultCredentials: true,
	container: false,
	insecureTransportOk: false,
};

/** Router table: "METHOD /path" -> response(s), consumed in order when an array. */
function stubFetch(table: Record<string, Route | Route[]>) {
	const calls: { url: string; method: string }[] = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		calls.push({ url, method });
		const key = `${method} ${url}`;
		const entry = table[key];
		if (!entry) throw new Error(`unstubbed request: ${key}`);
		const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
		return jsonResponse(route);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, calls };
}

function AppRoutes(): JSX.Element | null {
	return useRoutes(routes);
}

function renderApp(initialEntry = "/") {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[initialEntry]}>
				<AppRoutes />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	setAuthHandlers({});
});

afterEach(() => {
	vi.unstubAllGlobals();
	setAuthHandlers({});
});

describe("AuthGate", () => {
	it("redirects to /login when GET /api/auth/me returns 401", async () => {
		stubFetch({
			"GET /api/auth/me": {
				status: 401,
				body: { error: { code: "unauthenticated", message: "" } },
			},
		});
		renderApp("/workspaces");
		expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
	});

	it("shows the default-credentials hint only when the server reports them", async () => {
		stubFetch({
			"GET /api/auth/me": {
				status: 401,
				body: { error: { code: "unauthenticated", message: "" } },
			},
			"GET /api/health": { status: 200, body: HEALTH },
		});
		renderApp("/login");
		expect(await screen.findByText(/default credentials: test \/ test/i)).toBeInTheDocument();
	});

	it("logs in and lands on the app shell", async () => {
		const { calls } = stubFetch({
			"GET /api/auth/me": [
				{ status: 401, body: { error: { code: "unauthenticated", message: "" } } },
				{ status: 200, body: ADMIN_ME },
			],
			"GET /api/health": { status: 200, body: HEALTH },
			"POST /api/auth/login": { status: 200, body: { user: ADMIN_ME.user } },
		});
		// starts guarded: the gate bounces to /login, the login sends us back
		renderApp("/workspaces");

		await userEvent.type(await screen.findByLabelText(/username/i), "test");
		await userEvent.type(screen.getByLabelText(/password/i), "test");
		await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

		expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
		expect(await screen.findByRole("link", { name: "Conversations" })).toBeInTheDocument();
		expect(calls.some((c) => c.method === "POST" && c.url === "/api/auth/login")).toBe(true);
	});

	it("shows an error message when the credentials are refused", async () => {
		stubFetch({
			"GET /api/auth/me": {
				status: 401,
				body: { error: { code: "unauthenticated", message: "" } },
			},
			"GET /api/health": { status: 200, body: HEALTH },
			"POST /api/auth/login": {
				status: 401,
				body: { error: { code: "invalid_credentials", message: "Invalid username or password." } },
			},
		});
		renderApp("/login");
		await userEvent.type(await screen.findByLabelText(/username/i), "test");
		await userEvent.type(screen.getByLabelText(/password/i), "nope");
		await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
		expect(await screen.findByText(/invalid username or password/i)).toBeInTheDocument();
	});

	it("offers a user menu that signs out", async () => {
		const { calls } = stubFetch({
			"GET /api/auth/me": [
				{ status: 200, body: ADMIN_ME },
				{ status: 401, body: { error: { code: "unauthenticated", message: "" } } },
			],
			"GET /api/health": { status: 200, body: HEALTH },
			"POST /api/auth/logout": { status: 204 },
		});
		renderApp("/");
		await userEvent.click(await screen.findByRole("button", { name: /local user/i }));
		await userEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));
		expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
		expect(calls.some((c) => c.url === "/api/auth/logout")).toBe(true);
	});

	it("hides admin-only navigation from a non-admin principal", async () => {
		stubFetch({
			"GET /api/auth/me": { status: 200, body: USER_ME },
			"GET /api/health": { status: 200, body: HEALTH },
		});
		renderApp("/");
		expect(await screen.findByRole("link", { name: "Conversations" })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
	});
});

describe("fetch layer", () => {
	it("routes a 401 to the unauthenticated handler", async () => {
		stubFetch({
			"GET /api/meta": { status: 401, body: { error: { code: "unauthenticated", message: "" } } },
		});
		const onUnauthenticated = vi.fn();
		setAuthHandlers({ onUnauthenticated });
		await expect(request("/meta")).rejects.toBeInstanceOf(ApiClientError);
		expect(onUnauthenticated).toHaveBeenCalledOnce();
	});

	it("asks for a step-up on 403 step_up_required and retries the original request once", async () => {
		const { calls } = stubFetch({
			"POST /api/providers/x/auth/start": [
				{
					status: 403,
					body: { error: { code: "step_up_required", message: "Re-enter your password." } },
				},
				{ status: 200, body: { ok: true } },
			],
		});
		const onStepUpRequired = vi.fn().mockResolvedValue(true);
		setAuthHandlers({ onStepUpRequired });

		await expect(request("/providers/x/auth/start", { method: "POST", body: {} })).resolves.toEqual(
			{ ok: true },
		);
		expect(onStepUpRequired).toHaveBeenCalledOnce();
		expect(calls.filter((c) => c.url === "/api/providers/x/auth/start")).toHaveLength(2);
	});

	it("retries at most once when the step-up is cancelled", async () => {
		const { calls } = stubFetch({
			"POST /api/providers/x/auth/start": {
				status: 403,
				body: { error: { code: "step_up_required", message: "Re-enter your password." } },
			},
		});
		setAuthHandlers({ onStepUpRequired: vi.fn().mockResolvedValue(false) });
		await expect(request("/providers/x/auth/start", { method: "POST", body: {} })).rejects.toThrow(
			/re-enter your password/i,
		);
		expect(calls).toHaveLength(1);
	});
});

describe("StepUpDialog", () => {
	it("submits the password, closes, and lets the retry proceed", async () => {
		const { calls } = stubFetch({
			"GET /api/auth/me": { status: 200, body: ADMIN_ME },
			"GET /api/health": { status: 200, body: HEALTH },
			"POST /api/auth/step-up": { status: 204 },
			"POST /api/providers/x/auth/start": [
				{
					status: 403,
					body: { error: { code: "step_up_required", message: "Re-enter your password." } },
				},
				{ status: 200, body: { ok: true } },
			],
		});
		renderApp("/");
		await screen.findByRole("link", { name: "Conversations" });

		const pending = request<{ ok: boolean }>("/providers/x/auth/start", {
			method: "POST",
			body: {},
		});

		const field = await screen.findByLabelText(/password/i);
		await userEvent.type(field, "test");
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await expect(pending).resolves.toEqual({ ok: true });
		await waitFor(() => expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument());
		expect(calls.filter((c) => c.url === "/api/auth/step-up")).toHaveLength(1);
	});

	it("keeps the dialog open and shows the error when the password is wrong", async () => {
		stubFetch({
			"GET /api/auth/me": { status: 200, body: ADMIN_ME },
			"GET /api/health": { status: 200, body: HEALTH },
			"POST /api/auth/step-up": {
				status: 401,
				body: { error: { code: "invalid_credentials", message: "Invalid password." } },
			},
			"POST /api/providers/x/auth/start": {
				status: 403,
				body: { error: { code: "step_up_required", message: "Re-enter your password." } },
			},
		});
		renderApp("/");
		await screen.findByRole("link", { name: "Conversations" });

		const pending = request("/providers/x/auth/start", { method: "POST", body: {} }).catch(
			(e: Error) => e,
		);
		await userEvent.type(await screen.findByLabelText(/password/i), "nope");
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		expect(await screen.findByText(/invalid password/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/password/i)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(await pending).toBeInstanceOf(ApiClientError);
	});
});
