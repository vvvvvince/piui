// Typed fetch wrapper: always sends X-Requested-With, always unwraps the error envelope,
// and carries the two auth interceptors of spec/06-auth.md §6 / spec/14-credentials.md §5.
import type {
	ApiErrorBody,
	ApiErrorCode,
	HealthResponse,
	LoginResponse,
	MeResponse,
	MetaResponse,
} from "@piui/shared";

export class ApiClientError extends Error {
	constructor(
		readonly code: ApiErrorCode | "network_error",
		message: string,
		readonly status: number,
		readonly details?: { path: string; message: string }[],
	) {
		super(message);
		this.name = "ApiClientError";
	}
}

export interface RequestOptions {
	method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	body?: unknown;
	signal?: AbortSignal;
}

export interface AuthHandlers {
	/** Any 401: drop the cached user and send the browser to /login. */
	onUnauthenticated?: () => void;
	/** 403 step_up_required: open the dialog; resolve true once the step-up succeeded. */
	onStepUpRequired?: () => Promise<boolean>;
}

let authHandlers: AuthHandlers = {};

/** Wiring point for AuthGate; tests install their own handlers. */
export function setAuthHandlers(handlers: AuthHandlers): void {
	authHandlers = handlers;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	try {
		return await send<T>(path, options);
	} catch (error) {
		if (!(error instanceof ApiClientError)) throw error;
		// A refused password (login / step-up) is not a lost session: only `unauthenticated` is.
		if (error.status === 401 && error.code !== "invalid_credentials") {
			authHandlers.onUnauthenticated?.();
			throw error;
		}
		// Exactly one retry, and only after a successful step-up (spec/14-credentials.md §5).
		if (error.code === "step_up_required" && authHandlers.onStepUpRequired) {
			const confirmed = await authHandlers.onStepUpRequired();
			if (confirmed) return await send<T>(path, options);
		}
		throw error;
	}
}

async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const method = options.method ?? "GET";
	let response: Response;
	try {
		response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
			method,
			credentials: "same-origin",
			headers: {
				"X-Requested-With": "piui",
				...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		throw new ApiClientError("network_error", (error as Error).message, 0);
	}

	if (response.status === 204) return undefined as T;

	const text = await response.text();
	const payload = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

	if (!response.ok) {
		const body = payload as ApiErrorBody | undefined;
		throw new ApiClientError(
			body?.error?.code ?? "internal_error",
			body?.error?.message ?? `Request failed with status ${response.status}.`,
			response.status,
			body?.error?.details,
		);
	}
	return payload as T;
}

export const api = {
	health: () => request<HealthResponse>("/health"),
	meta: () => request<MetaResponse>("/meta"),
	me: () => request<MeResponse>("/auth/me"),
	login: (username: string, password: string) =>
		request<LoginResponse>("/auth/login", { method: "POST", body: { username, password } }),
	logout: () => request<void>("/auth/logout", { method: "POST" }),
	stepUp: (password: string) =>
		request<void>("/auth/step-up", { method: "POST", body: { password } }),
};
