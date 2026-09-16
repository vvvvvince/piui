// spec/09-api.md §0 — one error envelope, always.
import type { ApiErrorBody, ApiErrorCode } from "@piui/shared";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
	unauthenticated: 401,
	invalid_credentials: 401,
	csrf_check_failed: 403,
	forbidden: 403,
	not_found: 404,
	validation_error: 400,
	profile_name_taken: 409,
	workspace_name_taken: 409,
	path_not_absolute: 400,
	path_not_found: 400,
	path_not_directory: 400,
	path_not_writable: 400,
	path_not_allowed: 403,
	path_denylisted: 403,
	path_already_registered: 409,
	path_escape: 400,
	// spec/09-api.md §5: GET /api/workspaces/:id/file on a binary file.
	binary_file: 415,
	skill_invalid: 400,
	// spec/05-skills-and-tools.md §A.1: external skills are read-only in piui.
	skill_not_editable: 409,
	// spec/03-profiles.md §7.
	agents_md_too_large: 400,
	tool_name_taken: 409,
	model_unavailable: 400,
	// spec/04-workspaces.md §3: prompting into a workspace whose folder is gone.
	workspace_missing: 409,
	// spec/08-agent-mode.md §1 spells this one out as a 404 (§0's list has no status).
	profile_not_found: 404,
	conversation_busy: 409,
	immutable_after_start: 409,
	too_many_runs: 429,
	rate_limited: 429,
	// spec/09-api.md §7: POST /api/tools/web_search/test answers 503 when unset.
	provider_not_configured: 503,
	step_up_required: 403,
	provider_not_found: 404,
	provider_ambient_only: 409,
	auth_type_not_supported: 501,
	too_many_flows: 429,
	flow_not_found: 404,
	flow_not_prompting: 409,
	flow_prompt_mismatch: 409,
	credential_not_removable: 409,
	credential_writes_disabled: 403,
	insecure_transport: 403,
	// spec/16-extensions.md §9.
	extension_name_taken: 409,
	extension_load_failed: 400,
	extension_not_editable: 409,
	extension_install_disabled: 403,
	extension_too_large: 413,
	internal_error: 500,
};

export class ApiError extends Error {
	readonly statusCode: number;

	constructor(
		readonly code: ApiErrorCode,
		message: string,
		readonly details?: { path: string; message: string }[],
	) {
		super(message);
		this.name = "ApiError";
		this.statusCode = STATUS_BY_CODE[code] ?? 500;
	}

	toBody(): ApiErrorBody {
		return {
			error: {
				code: this.code,
				message: this.message,
				...(this.details ? { details: this.details } : {}),
			},
		};
	}
}

export const notFound = (message = "Not found.") => new ApiError("not_found", message);
export const forbidden = (message: string) => new ApiError("forbidden", message);
export const unauthenticated = (message = "Authentication required.") =>
	new ApiError("unauthenticated", message);
export const validationError = (message: string, details?: { path: string; message: string }[]) =>
	new ApiError("validation_error", message, details);
export const statusForCode = (code: ApiErrorCode): number => STATUS_BY_CODE[code] ?? 500;
