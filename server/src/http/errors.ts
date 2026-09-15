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
	skill_invalid: 400,
	tool_name_taken: 409,
	model_unavailable: 400,
	workspace_missing: 400,
	profile_not_found: 400,
	conversation_busy: 409,
	immutable_after_start: 409,
	too_many_runs: 429,
	rate_limited: 429,
	provider_not_configured: 400,
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
