// HTTP DTOs. Source of truth: spec/09-api.md.
import type {
	ConversationSummary,
	ModelInfo,
	Principal,
	SessionMode,
	ThinkingLevel,
	ToolCatalogItem,
	ToolDescriptor,
} from "./domain.js";
import type { ConversationRuntimeState, UiMessage } from "./events.js";

export interface ApiErrorBody {
	error: {
		code: ApiErrorCode;
		message: string;
		details?: { path: string; message: string }[];
	};
}

export type ApiErrorCode =
	| "unauthenticated"
	| "invalid_credentials"
	| "csrf_check_failed"
	| "forbidden"
	| "not_found"
	| "validation_error"
	| "profile_name_taken"
	| "workspace_name_taken"
	| "path_not_absolute"
	| "path_not_found"
	| "path_not_directory"
	| "path_not_writable"
	| "path_not_allowed"
	| "path_denylisted"
	| "path_already_registered"
	| "path_escape"
	| "skill_invalid"
	| "tool_name_taken"
	| "model_unavailable"
	| "workspace_missing"
	| "profile_not_found"
	| "conversation_busy"
	| "immutable_after_start"
	| "too_many_runs"
	| "rate_limited"
	| "provider_not_configured"
	| "step_up_required"
	// spec/14-credentials.md §3
	| "provider_not_found"
	| "provider_ambient_only"
	| "auth_type_not_supported"
	| "too_many_flows"
	| "flow_not_found"
	| "flow_not_prompting"
	| "flow_prompt_mismatch"
	| "credential_not_removable"
	| "credential_writes_disabled"
	| "insecure_transport"
	| "internal_error";

export interface HealthResponse {
	ok: boolean;
	version: string;
	piVersion: string;
	defaultCredentials: boolean;
	container: boolean;
	insecureTransportOk: boolean;
}

export interface MetaResponse {
	searchProvider: { id: string; configured: boolean };
	workspaceRoots: string[];
	limits: { maxUploadMb: number; maxConcurrentRuns: number; maxRunMinutes: number };
	platform: string;
}

/** POST /api/auth/login (spec/09-api.md §2). */
export interface LoginRequest {
	username: string;
	password: string;
}

export interface LoginResponse {
	user: Principal;
}

/** GET /api/auth/me — `user.roles` drives admin-only UI. */
export interface MeResponse {
	user: Principal;
	stepUpValidUntil: string | null;
}

/** POST /api/auth/step-up (spec/14-credentials.md §5). */
export interface StepUpRequest {
	password: string;
}

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

// ------------------------------------------------- providers & credentials
// spec/14-credentials.md §§2-3 (replaces spec/09-api.md §3's provider table).

export interface ProviderAuthMethod {
	type: "api_key" | "oauth";
	name: string;
	interactive: boolean;
	isSubscription?: boolean;
	loginLabel?: string;
	/** V1 (decision Q1 = B): true only for api_key. */
	enabledInPiui: boolean;
}

export type CredentialSource =
	| "stored"
	| "runtime"
	| "environment"
	| "fallback"
	| "models_json_key"
	| "models_json_command";

export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	source?: CredentialSource;
	label?: string;
	credentialType?: "api_key" | "oauth";
	/** Only `source === "stored"` credentials can be deleted from piui. */
	removable: boolean;
	methods: ProviderAuthMethod[];
	modelCount: number;
	availableModelCount: number;
}

export interface ProvidersResponse {
	items: ProviderStatus[];
	credentialWritesEnabled: boolean;
	/** `~`-abbreviated path of the pi auth file (a path, not a secret). */
	authPath: string;
}

export type UiAuthPrompt =
	| {
			id: string;
			type: "text" | "secret" | "manual_code";
			message: string;
			placeholder?: string;
	  }
	| {
			id: string;
			type: "select";
			message: string;
			options: { id: string; label: string; description?: string }[];
	  };

export type UiAuthEvent =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/** `version` is the `?since=` cursor of the long-poll in spec/14-credentials.md §3. */
export type AuthFlowView = { flowId: string; providerId: string; version: number } & (
	| { state: "prompting"; prompt: UiAuthPrompt; events: UiAuthEvent[] }
	| { state: "working"; events: UiAuthEvent[] }
	| { state: "done"; status: ProviderStatus; warning?: string; events: UiAuthEvent[] }
	| { state: "error"; message: string; events: UiAuthEvent[] }
	| { state: "cancelled"; events: UiAuthEvent[] }
);

export interface StartAuthRequest {
	type?: "api_key" | "oauth";
	apiKey?: string;
	env?: Record<string, string>;
}

export interface RespondAuthRequest {
	flowId: string;
	promptId: string;
	value: string;
}

export interface CancelAuthRequest {
	flowId: string;
}

export interface VerifyProviderResponse {
	configured: boolean;
	models: number;
	source?: string;
	label?: string;
	error?: string;
}

// ------------------------------------------------------------------ models

export interface ModelsResponse {
	items: ModelInfo[];
	credentialsRevision: number;
	refresh?: { aborted: boolean; errors: { provider: string; message: string }[] };
}

// ------------------------------------------------------------------- tools
// spec/09-api.md §7.

export interface ToolsResponse {
	items: ToolCatalogItem[];
	webSearch: { provider: string; configured: boolean };
}

export interface PatchToolRequest {
	enabled: boolean;
}

export interface SearchTestRequest {
	query: string;
}

export interface SearchTestResult {
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
}

export interface SearchTestResponse {
	provider: string;
	results: SearchTestResult[];
}

// ----------------------------------------------------------- conversations

export interface ConversationDetail extends ConversationSummary {
	tools: ToolDescriptor[];
	/** The real composed system prompt, truncated to 4 KB (spec/09-api.md §8). */
	systemPromptPreview: string;
	state: ConversationRuntimeState;
}

export interface CreateConversationRequest {
	mode: SessionMode;
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	profileId?: string;
	workspaceId?: string;
	webSearch?: boolean;
	title?: string;
	timezone?: string;
	initialMessage?: string;
}

export interface CreateConversationResponse {
	conversation: ConversationDetail;
	warnings: string[];
}

export interface PatchConversationRequest {
	title?: string;
	archived?: boolean;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	webSearch?: boolean;
}

export interface PostMessageRequest {
	text: string;
	streamingBehavior?: "steer" | "followUp";
}

export interface PostMessageResponse {
	accepted: true;
	queuedAs: "steer" | "followUp" | null;
}

export interface MessagesResponse {
	messages: UiMessage[];
	seq: number;
}

export interface QueueResponse {
	steering: string[];
	followUp: string[];
}

export interface AbortResponse {
	restored: QueueResponse;
}

export interface ConversationStatsResponse {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage: { tokens: number; contextWindow: number; percent: number } | null;
	messages: { user: number; assistant: number; toolCalls: number };
}

/** spec/09-api.md §9 — the global notification channel. */
export type GlobalEvent =
	| { type: "conversation_state"; conversationId: string; isStreaming: boolean }
	| { type: "conversation_title"; conversationId: string; title: string }
	| { type: "conversation_done"; conversationId: string }
	| { type: "skills_changed" }
	| { type: "providers_changed" }
	| { type: "extensions_changed" }
	| { type: "ping" };

/** Mutating requests must carry this header (spec/09-api.md §0). */
export const REQUESTED_WITH_HEADER = "x-requested-with";
export const REQUESTED_WITH_VALUE = "piui";
