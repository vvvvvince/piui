// HTTP DTOs. Source of truth: spec/09-api.md.
import type {
	ConversationSummary,
	ModelInfo,
	Principal,
	Profile,
	SessionMode,
	SkillFileEntry,
	SkillSummary,
	SkillValidation,
	ThinkingLevel,
	ToolCatalogItem,
	ToolDescriptor,
	Workspace,
	WorkspaceStatus,
} from "./domain.js";
import type { ConversationRuntimeState, UiMessage } from "./events.js";

export interface ApiErrorBody {
	error: {
		code: ApiErrorCode;
		message: string;
		details?: { path: string; message: string }[];
		/** spec/11-security.md §8 — pairs an `internal_error` with its server log line. */
		correlationId?: string;
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
	| "binary_file"
	| "skill_invalid"
	// spec/05-skills-and-tools.md §A.1 — external skills are read-only in piui.
	| "skill_not_editable"
	// spec/03-profiles.md §7
	| "agents_md_too_large"
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
	// spec/16-extensions.md §9
	| "extension_name_taken"
	| "extension_load_failed"
	| "extension_not_editable"
	| "extension_install_disabled"
	| "extension_too_large"
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

// spec/05-skills-and-tools.md §B.2 — user-defined HTTP tools.

export type HttpToolParamType = "string" | "number" | "boolean" | "string[]";

/** One row of the schema builder; the server turns these into a JSON-Schema object. */
export interface HttpToolParam {
	name: string;
	type: HttpToolParamType;
	required: boolean;
	description?: string;
}

export interface HttpToolDetail {
	id: string;
	name: string;
	label: string;
	description: string;
	enabled: boolean;
	method: "GET" | "POST";
	urlTemplate: string;
	/** Values are ALWAYS `"***"`: a stored header value never leaves the server (§B.2). */
	headers: Record<string, string>;
	bodyTemplate: string | null;
	parameters: HttpToolParam[];
	/** The composed JSON Schema the model sees. */
	parametersSchema: Record<string, unknown>;
	timeoutMs: number;
	usedByProfiles: number;
}

export interface HttpToolsResponse {
	items: HttpToolDetail[];
}

export interface CreateHttpToolRequest {
	name: string;
	label?: string;
	description: string;
	method?: "GET" | "POST";
	urlTemplate: string;
	/** Omit a key to keep the stored value; send `""` to delete it. */
	headers?: Record<string, string>;
	bodyTemplate?: string | null;
	parameters?: HttpToolParam[];
	/** Advanced mode: a raw JSON-Schema object, used instead of `parameters`. */
	parametersSchema?: Record<string, unknown>;
	timeoutMs?: number;
	enabled?: boolean;
}

export type PatchHttpToolRequest = Partial<CreateHttpToolRequest>;

export interface HttpToolTestRequest {
	params?: Record<string, unknown>;
}

export interface HttpToolTestResponse {
	status: number;
	durationMs: number;
	body: string;
	truncated: boolean;
}

export interface DeleteHttpToolResponse {
	affectedProfiles: string[];
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

// -------------------------------------------------------------- workspaces
// spec/09-api.md §5.

export interface WorkspacesResponse {
	items: Workspace[];
}

export interface CreateWorkspaceRequest {
	name: string;
	path: string;
	description?: string;
	/** mkdir the folder (recursive, 0o755) instead of requiring it to exist. */
	create?: boolean;
	gitInit?: boolean;
}

export interface PatchWorkspaceRequest {
	name?: string;
	description?: string;
	path?: string;
	trusted?: boolean;
}

export interface ValidatePathRequest {
	path: string;
	create?: boolean;
}

export interface ValidatePathResponse {
	ok: true;
	normalizedPath: string;
	status: WorkspaceStatus;
}

export interface DeleteWorkspaceResponse {
	affectedConversations: number;
}

export interface TreeEntry {
	name: string;
	kind: "file" | "dir" | "symlink";
	size?: number;
	modifiedAt: string;
	hidden: boolean;
}

export interface WorkspaceTreeResponse {
	path: string;
	entries: TreeEntry[];
	truncated: boolean;
}

export interface WorkspaceFileResponse {
	path: string;
	content: string;
	size: number;
	truncated: boolean;
	language: string;
}

export interface WorkspaceGitResponse {
	available: boolean;
	branch?: string;
	ahead?: number;
	behind?: number;
	dirtyCount?: number;
	staged?: number;
	lastCommit?: { hash: string; subject: string; at: string };
}

export interface FsBrowseResponse {
	path: string;
	parent: string | null;
	dirs: string[];
}

// --------------------------------------------------------------- profiles
// spec/09-api.md §4.

/** List rows carry the size instead of the body (§4). */
export interface ProfileSummary extends Omit<Profile, "agentsMd"> {
	agentsMdSize: number;
	usedByConversations: number;
}

export interface ProfileDetail extends Profile {
	agentsMdSize: number;
	usedByConversations: number;
	/** What this profile can actually do right now (spec/05-skills-and-tools.md §B.4). */
	resolvedTools: ToolDescriptor[];
	warnings: string[];
}

export interface ProfilesResponse {
	items: ProfileSummary[];
}

export interface CreateProfileRequest {
	name: string;
	description?: string;
	agentsMd?: string;
	skillIds?: string[];
	toolNames?: string[];
	includeDiscoveredSkills?: boolean;
	/** spec/16-extensions.md §3 — extensions switched off for this profile. */
	disabledExtensionIds?: string[];
	allowDynamicExtensionTools?: boolean;
	memory?: { enabled: boolean; path?: string | null };
	defaults?: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel };
}

export type PatchProfileRequest = Partial<CreateProfileRequest>;

export interface DeleteProfileResponse {
	affectedConversations: number;
}

/** GET /api/profiles/:id/memory — Phase 0 also reports what is injected (spec/17 §6.4). */
export interface ProfileMemoryResponse {
	path: string;
	enabled: boolean;
	sizeBytes: number;
	modifiedAt: string | null;
	content: string;
	truncated: boolean;
	injectedBytes: number;
	noteCount: number;
}

// ------------------------------------------------- commands & prompt templates

/** spec/15-commands-and-input.md §1.1. */
export interface CommandDescriptor {
	name: string;
	display: string;
	description: string;
	argumentHint?: string;
	source: "builtin" | "prompt" | "skill" | "extension";
	location?: "piui" | "user" | "project";
	/** How the client executes it (spec §2). */
	kind: "client" | "server" | "expand";
	availableWhileStreaming: boolean;
}

export interface CommandsResponse {
	items: CommandDescriptor[];
}

/** spec/15-commands-and-input.md §5. */
export interface PromptTemplateSummary {
	name: string;
	description: string;
	argumentHint?: string;
	location: "piui" | "user" | "project";
	path: string;
	/** A same-named template from a lower-precedence source that this one hides. */
	shadows?: ("piui" | "user")[];
}

export interface PromptsResponse {
	items: PromptTemplateSummary[];
	/** The three source directories with their counts, for the Settings page. */
	sources: { location: "piui" | "user" | "project"; path: string; count: number }[];
}

export interface PromptRescanResponse {
	added: number;
	updated: number;
	removed: number;
}

/** spec/09-api.md §5 — drives the workspace trust dialog (spec/15 §3.3). */
export interface ProjectResourcesResponse {
	hasPiDir: boolean;
	prompts: string[];
	skills: string[];
	extensions: string[];
	settings: boolean;
	trusted: boolean;
	trustDecidedAt: string | null;
}

export interface SkillsResponse {
	items: SkillSummary[];
}

/** spec/05-skills-and-tools.md §A.4 — the three starters offered by "New skill". */
export type SkillTemplate = "basic" | "script" | "reference";

export interface CreateSkillRequest {
	name: string;
	description: string;
	body?: string;
	template?: SkillTemplate;
}

export interface PatchSkillRequest {
	name?: string;
	description?: string;
	body?: string;
	enabled?: boolean;
	/** Raw mode (§A.4): the whole SKILL.md, still validated before it is written. */
	raw?: string;
}

export interface SkillDetail extends SkillSummary {
	files: SkillFileEntry[];
	skillMd: { name: string; description: string; body: string; raw: string };
	validation: SkillValidation;
	/** External skills are read-only in piui (§A.1). */
	editable: boolean;
}

export interface SkillFileResponse {
	path: string;
	content: string;
	size: number;
}

export interface PutSkillFileRequest {
	content: string;
}

export interface DeleteSkillResponse {
	affectedProfiles: string[];
}

/** POST /api/skills/import — one of the three shapes of §A.4. */
export interface ImportSkillRequest {
	path?: string;
	skillMd?: string;
}

export interface SkillRescanResponse {
	added: number;
	updated: number;
	missing: number;
}

/** POST /api/skills/:id/test (§A.4). */
export interface SkillTestRequest {
	allowBash?: boolean;
	provider?: string;
	modelId?: string;
}

export interface SkillTestResponse {
	conversationId: string;
	ephemeral: true;
}

// ------------------------------------------------------------- extensions
// spec/16-extensions.md §9.

export interface ExtensionSummary {
	id: string;
	name: string;
	source: "managed" | "external";
	origin: string | null;
	path: string;
	enabled: boolean;
	loadError: string | null;
	tools: string[];
	commands: string[];
	disabledInProfiles: number;
	editable: boolean;
}

export interface ExtensionsResponse {
	items: ExtensionSummary[];
	/** false when PIUI_DISABLE_EXTENSION_INSTALL=1 (spec §7.4). */
	installEnabled: boolean;
}

export interface ExtensionDetail extends ExtensionSummary {
	/** Managed extensions only; null for external ones (never edited by piui). */
	source_text: string | null;
}

/** Paste (`name` + `source`) or register an external path (`path`). */
export interface CreateExtensionRequest {
	name?: string;
	source?: string;
	path?: string;
	/** Provenance for the audit line: the URL or upload filename a paste came from. */
	origin?: string;
}

export interface FetchExtensionRequest {
	url: string;
}

/** The review step: the full source, never installed (spec §7.1). */
export interface FetchExtensionResponse {
	name: string;
	source: string;
	sha256: string;
	bytes: number;
}

export interface PatchExtensionRequest {
	enabled?: boolean;
	source?: string;
}

export interface DeleteExtensionResponse {
	affectedProfiles: string[];
	removedTools: string[];
	removedCommands: string[];
}

export interface ExtensionRescanResponse {
	added: number;
	updated: number;
	removed: number;
	errors: { path: string; error: string }[];
}

/** POST /api/conversations/:id/ui-response (spec §5). */
export interface UiResponseRequest {
	requestId: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
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
	/** Rejected with `409 immutable_after_start` once the session exists (spec/09-api.md §8). */
	profileId?: string;
	workspaceId?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	webSearch?: boolean;
}

/** spec/09-api.md §10 — an upload id, or a small image inlined as base64. */
export interface MessageAttachmentInput {
	uploadId?: string;
	mimeType?: string;
	data?: string;
}

export interface PostMessageRequest {
	text: string;
	streamingBehavior?: "steer" | "followUp";
	attachments?: MessageAttachmentInput[];
}

/** POST /api/uploads (spec/09-api.md §10). */
export interface UploadResponse {
	id: string;
	url: string;
	mimeType: string;
	size: number;
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

/** spec/09-api.md §8 — `POST /api/conversations/:id/compact`. */
export interface CompactRequest {
	customInstructions?: string;
}

export interface CompactResponse {
	summary: string;
	tokensBefore: number;
	estimatedTokensAfter: number;
	cost: number;
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
