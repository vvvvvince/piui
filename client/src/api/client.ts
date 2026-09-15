// Typed fetch wrapper: always sends X-Requested-With, always unwraps the error envelope.
// spec/09-api.md §0. (401 / 403-step-up interceptors arrive in M1.)
import type { ApiErrorBody, ApiErrorCode, HealthResponse, MetaResponse } from "@piui/shared";

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

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
};
