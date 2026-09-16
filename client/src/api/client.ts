// Typed fetch wrapper: always sends X-Requested-With, always unwraps the error envelope,
// and carries the two auth interceptors of spec/06-auth.md §6 / spec/14-credentials.md §5.
import type {
	AbortResponse,
	ApiErrorBody,
	ApiErrorCode,
	AuthFlowView,
	CommandsResponse,
	ConversationDetail,
	ConversationStatsResponse,
	ConversationSummary,
	CreateConversationRequest,
	CreateConversationResponse,
	CreateExtensionRequest,
	CreateProfileRequest,
	CreateWorkspaceRequest,
	DeleteExtensionResponse,
	DeleteProfileResponse,
	DeleteWorkspaceResponse,
	ExtensionDetail,
	ExtensionRescanResponse,
	ExtensionSummary,
	ExtensionsResponse,
	FetchExtensionResponse,
	FsBrowseResponse,
	HealthResponse,
	LoginResponse,
	MeResponse,
	MessagesResponse,
	MetaResponse,
	ModelsResponse,
	PatchConversationRequest,
	PatchExtensionRequest,
	PatchProfileRequest,
	PatchWorkspaceRequest,
	PostMessageResponse,
	ProfileDetail,
	ProfileMemoryResponse,
	ProfilesResponse,
	ProjectResourcesResponse,
	PromptRescanResponse,
	PromptsResponse,
	ProviderStatus,
	ProvidersResponse,
	QueueResponse,
	SearchTestResponse,
	SkillsResponse,
	ToolCatalogItem,
	ToolsResponse,
	UiResponseRequest,
	ValidatePathResponse,
	VerifyProviderResponse,
	Workspace,
	WorkspaceFileResponse,
	WorkspaceGitResponse,
	WorkspacesResponse,
	WorkspaceTreeResponse,
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

	// --------------------------------------------------------------- profiles
	profiles: () => request<ProfilesResponse>("/profiles"),
	profile: (id: string) => request<ProfileDetail>(`/profiles/${id}`),
	createProfile: (body: CreateProfileRequest) =>
		request<ProfileDetail>("/profiles", { method: "POST", body }),
	patchProfile: (id: string, body: PatchProfileRequest) =>
		request<ProfileDetail>(`/profiles/${id}`, { method: "PATCH", body }),
	deleteProfile: (id: string) =>
		request<DeleteProfileResponse>(`/profiles/${id}`, { method: "DELETE" }),
	duplicateProfile: (id: string) =>
		request<ProfileDetail>(`/profiles/${id}/duplicate`, { method: "POST" }),
	profileMemory: (id: string) => request<ProfileMemoryResponse>(`/profiles/${id}/memory`),
	putProfileMemory: (id: string, content: string) =>
		request<{ sizeBytes: number }>(`/profiles/${id}/memory`, { method: "PUT", body: { content } }),
	clearProfileMemory: (id: string) => request<void>(`/profiles/${id}/memory`, { method: "DELETE" }),
	skills: () => request<SkillsResponse>("/skills"),

	// ------------------------------------------------------------- workspaces
	workspaces: () => request<WorkspacesResponse>("/workspaces"),
	createWorkspace: (body: CreateWorkspaceRequest) =>
		request<Workspace>("/workspaces", { method: "POST", body }),
	patchWorkspace: (id: string, body: PatchWorkspaceRequest) =>
		request<Workspace>(`/workspaces/${id}`, { method: "PATCH", body }),
	deleteWorkspace: (id: string) =>
		request<DeleteWorkspaceResponse>(`/workspaces/${id}`, { method: "DELETE" }),
	validatePath: (path: string, create?: boolean) =>
		request<ValidatePathResponse>("/workspaces/validate", {
			method: "POST",
			body: { path, ...(create ? { create: true } : {}) },
		}),
	projectResources: (id: string) =>
		request<ProjectResourcesResponse>(`/workspaces/${id}/project-resources`),
	workspaceTree: (id: string, path = "") =>
		request<WorkspaceTreeResponse>(`/workspaces/${id}/tree?path=${encodeURIComponent(path)}`),
	workspaceFile: (id: string, path: string) =>
		request<WorkspaceFileResponse>(`/workspaces/${id}/file?path=${encodeURIComponent(path)}`),
	workspaceGit: (id: string) => request<WorkspaceGitResponse>(`/workspaces/${id}/git`),
	browse: (path?: string) =>
		request<FsBrowseResponse>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),

	// ---------------------------------------------------------- conversations
	conversations: () =>
		request<{ items: ConversationSummary[]; nextCursor: string | null }>("/conversations"),
	createConversation: (body: CreateConversationRequest) =>
		request<CreateConversationResponse>("/conversations", { method: "POST", body }),
	conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
	commands: (id: string) => request<CommandsResponse>(`/conversations/${id}/commands`),
	prompts: () => request<PromptsResponse>("/prompts"),
	rescanPrompts: () => request<PromptRescanResponse>("/prompts/rescan", { method: "POST" }),
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
	/** spec/16-extensions.md §5 — answering an extension dialog. */
	answerUiRequest: (id: string, body: UiResponseRequest) =>
		request<{ resolved: boolean }>(`/conversations/${id}/ui-response`, { method: "POST", body }),

	// ------------------------------------------------------------ extensions
	extensions: () => request<ExtensionsResponse>("/extensions"),
	extension: (id: string) => request<ExtensionDetail>(`/extensions/${id}`),
	installExtension: (body: CreateExtensionRequest) =>
		request<ExtensionSummary>("/extensions", { method: "POST", body }),
	fetchExtension: (url: string) =>
		request<FetchExtensionResponse>("/extensions/fetch", { method: "POST", body: { url } }),
	patchExtension: (id: string, body: PatchExtensionRequest) =>
		request<ExtensionSummary>(`/extensions/${id}`, { method: "PATCH", body }),
	deleteExtension: (id: string) =>
		request<DeleteExtensionResponse>(`/extensions/${id}`, { method: "DELETE" }),
	rescanExtensions: () =>
		request<ExtensionRescanResponse>("/extensions/rescan", { method: "POST" }),
	conversationStats: (id: string) =>
		request<ConversationStatsResponse>(`/conversations/${id}/stats`),
};
