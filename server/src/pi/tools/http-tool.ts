// A user-defined HTTP tool as a pi custom tool. spec/05-skills-and-tools.md §B.2.
//
// Header values are resolved **here, at call time** (`${ENV_VAR}` → the server's environment) and
// never travel anywhere else: not into the DB response, not into the tool output, not into logs.
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Type } from "typebox";
import type { FetchLike } from "../../context.js";
import { BlockedUrlError, type LookupFn, safeFetch, systemLookup } from "../../net/ssrf.js";
import { renderBody, renderUrl } from "../../tools/http-tools.js";
import type { PiTool } from "./web-search.js";

export const HTTP_TOOL_MAX_CHARS = 32 * 1024;

export interface HttpToolDefinition {
	id: string;
	name: string;
	label: string;
	description: string;
	method: "GET" | "POST";
	urlTemplate: string;
	headers: Record<string, string>;
	bodyTemplate: string | null;
	parametersSchema: Record<string, unknown>;
	timeoutMs: number;
}

export interface HttpToolDeps {
	definition: HttpToolDefinition;
	fetch: FetchLike;
	lookup?: LookupFn;
	/** `${ENV_VAR}` lookup; production passes config.ts's reader (the only env reader). */
	env: (name: string) => string | undefined;
	allowPrivate?: boolean;
	nowMs?: () => number;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** §B.2 — `${ENV_VAR}` is expanded at call time; an unset variable becomes the empty string. */
export function resolveHeaders(
	headers: Record<string, string>,
	env: (name: string) => string | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key] = value.replace(ENV_REF, (_, name: string) => env(name) ?? "");
	}
	return out;
}

export function createHttpTool(deps: HttpToolDeps): PiTool {
	const { definition } = deps;
	const lookup = deps.lookup ?? systemLookup;
	const now = deps.nowMs ?? (() => Date.now());

	return defineTool({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		// The stored schema is already a JSON-Schema object; pi hands it to the model as-is.
		parameters: definition.parametersSchema as unknown as ReturnType<typeof Type.Object>,
		async execute(_toolCallId, params) {
			const values = (params ?? {}) as Record<string, unknown>;
			const url = renderUrl(definition.urlTemplate, values);
			const body =
				definition.method === "POST" && definition.bodyTemplate
					? renderBody(definition.bodyTemplate, values)
					: undefined;
			const startedAt = now();
			let result: Awaited<ReturnType<typeof safeFetch>>;
			try {
				result = await safeFetch(url, {
					fetch: deps.fetch,
					lookup,
					method: definition.method,
					headers: {
						...resolveHeaders(definition.headers, deps.env),
						...(body === undefined ? {} : { "content-type": "application/json" }),
					},
					...(body === undefined ? {} : { body }),
					timeoutMs: definition.timeoutMs,
					maxBytes: HTTP_TOOL_MAX_CHARS + 1024,
					...(deps.allowPrivate === undefined ? {} : { allowPrivate: deps.allowPrivate }),
				});
			} catch (error) {
				// The guard's message is safe (it names the URL, never a header).
				throw new Error(
					error instanceof BlockedUrlError
						? `${definition.name} refused to call ${url}: ${error.message}`
						: `${definition.name} failed: ${(error as Error).message}`,
				);
			}
			const durationMs = now() - startedAt;
			const text = formatResponse(result);
			const details = {
				status: result.status,
				url: result.finalUrl,
				durationMs,
			};
			if (result.status < 200 || result.status >= 300) {
				// Models recover better when they can read the error body (§B.2).
				throw new Error(`${definition.name} returned HTTP ${result.status}.\n\n${text}`);
			}
			return { content: [{ type: "text", text }], details };
		},
	}) as unknown as PiTool;
}

/** JSON is pretty-printed, everything else is text; both truncated at 32 KB with a note. */
export function formatResponse(result: {
	body: string;
	contentType: string;
	truncated: boolean;
}): string {
	let text = result.body;
	if (result.contentType.includes("json")) {
		try {
			text = JSON.stringify(JSON.parse(result.body), null, 2);
		} catch {
			/* not actually JSON: fall back to the raw text */
		}
	}
	if (text.length > HTTP_TOOL_MAX_CHARS || result.truncated) {
		const kept = text.slice(0, HTTP_TOOL_MAX_CHARS);
		return `${kept}\n…[truncated, ${Math.max(text.length - HTTP_TOOL_MAX_CHARS, 0)} chars omitted]`;
	}
	return text;
}
