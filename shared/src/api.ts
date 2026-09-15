// HTTP DTOs. Source of truth: spec/09-api.md.

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

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

/** Mutating requests must carry this header (spec/09-api.md §0). */
export const REQUESTED_WITH_HEADER = "x-requested-with";
export const REQUESTED_WITH_VALUE = "piui";
