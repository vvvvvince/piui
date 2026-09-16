// Typed fetch wrapper: always sends X-Requested-With, always unwraps the error envelope,
// and carries the two auth interceptors of spec/06-auth.md §6 / spec/14-credentials.md §5.
import type {
	AbortResponse,
	ApiErrorBody,
	ApiErrorCode,
	AuthFlowView,
	ConversationDetail,
	ConversationStatsResponse,
	ConversationSummary,
	CreateConversationRequest,
	CreateConversationResponse,
	HealthResponse,
	LoginResponse,
	MeResponse,
	MessagesResponse,
	MetaResponse,
	ModelsResponse,
	PatchConversationRequest,
	PostMessageResponse,
	ProviderStatus,
	ProvidersResponse,
	QueueResponse,
	SearchTestResponse,
	ToolCatalogItem,
	ToolsResponse,
	VerifyProviderResponse,
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

	// ------------------------------------------------- models & credentials
	models: (refresh = false) => request<ModelsResponse>(`/models${refresh ? "?refresh=1" : ""}`),
	providers: () => request<ProvidersResponse>("/providers"),
	startAuth: (providerId: string, body: { apiKey?: string } = {}) =>
		request<AuthFlowView>(`/providers/${providerId}/auth/start`, { method: "POST", body }),
	respondAuth: (providerId: string, body: { flowId: string; promptId: string; value: string }) =>
		request<AuthFlowView>(`/providers/${providerId}/auth/respond`, { method: "POST", body }),
	cancelAuth: (providerId: string, flowId: string) =>
		request<AuthFlowView>(`/providers/${providerId}/auth/cancel`, {
			method: "POST",
			body: { flowId },
		}),
	pollAuth: (flowId: string, since: number) =>
		request<AuthFlowView>(`/providers/auth-flows/${flowId}?wait=25000&since=${since}`),
	deleteAuth: (providerId: string) =>
		request<ProviderStatus>(`/providers/${providerId}/auth`, { method: "DELETE" }),
	verifyProvider: (providerId: string) =>
		request<VerifyProviderResponse>(`/providers/${providerId}/verify`, { method: "POST" }),

	// ------------------------------------------------------------------ tools
	tools: () => request<ToolsResponse>("/tools"),
	patchTool: (name: string, enabled: boolean) =>
		request<ToolCatalogItem>(`/tools/${name}`, { method: "PATCH", body: { enabled } }),
	testSearch: (query: string) =>
		request<SearchTestResponse>("/tools/web_search/test", { method: "POST", body: { query } }),

	// ---------------------------------------------------------- conversations
	conversations: () =>
		request<{ items: ConversationSummary[]; nextCursor: string | null }>("/conversations"),
	createConversation: (body: CreateConversationRequest) =>
		request<CreateConversationResponse>("/conversations", { method: "POST", body }),
	conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
	conversationMessages: (id: string) => request<MessagesResponse>(`/conversations/${id}/messages`),
	patchConversation: (id: string, body: PatchConversationRequest) =>
		request<ConversationDetail>(`/conversations/${id}`, { method: "PATCH", body }),
	deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
	sendMessage: (id: string, body: { text: string; streamingBehavior?: "steer" | "followUp" }) =>
		request<PostMessageResponse>(`/conversations/${id}/messages`, { method: "POST", body }),
	abortConversation: (id: string) =>
		request<AbortResponse>(`/conversations/${id}/abort`, { method: "POST" }),
	clearQueue: (id: string) =>
		request<QueueResponse>(`/conversations/${id}/queue/clear`, { method: "POST" }),
	conversationStats: (id: string) =>
		request<ConversationStatsResponse>(`/conversations/${id}/stats`),
};
