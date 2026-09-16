// User-defined HTTP tools: validation, the parameter schema builder and the `{param}` renderer.
// spec/05-skills-and-tools.md §B.2. Pure — persistence lives in the repository, the runtime in
// server/src/pi/tools/http-tool.ts.
import type { HttpToolParam } from "@piui/shared";
import { ApiError } from "../http/errors.js";

export const HTTP_TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,47}$/;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 60_000;

export interface HttpToolInput {
	name: string;
	label?: string;
	description: string;
	method: "GET" | "POST";
	urlTemplate: string;
	headers: Record<string, string>;
	bodyTemplate: string | null;
	parameters?: HttpToolParam[];
	parametersSchema?: Record<string, unknown>;
	timeoutMs: number;
}

export interface ValidatedHttpTool extends HttpToolInput {
	label: string;
	parameters: HttpToolParam[];
	parametersSchema: Record<string, unknown>;
}

/** §B.2 — the builder rows become one JSON-Schema object (TypeBox-compatible). */
export function buildParametersSchema(params: readonly HttpToolParam[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const param of params) {
		const base =
			param.type === "string[]"
				? { type: "array", items: { type: "string" } }
				: { type: param.type };
		properties[param.name] = param.description ? { ...base, description: param.description } : base;
		if (param.required) required.push(param.name);
	}
	return { type: "object", additionalProperties: false, required, properties };
}

/** Parameter names a schema declares — the placeholder check runs against these. */
export function schemaParamNames(schema: Record<string, unknown>): string[] {
	const properties = schema.properties;
	return properties && typeof properties === "object" ? Object.keys(properties) : [];
}

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export function placeholders(template: string): string[] {
	return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** `{param}` in the URL, URL-encoded (§B.2). */
export function renderUrl(template: string, params: Record<string, unknown>): string {
	return template.replace(PLACEHOLDER, (whole, name: string) =>
		name in params ? encodeURIComponent(String(params[name])) : whole,
	);
}

/** `{param}` in the JSON body, JSON-encoded (so a string arrives quoted, a number bare). */
export function renderBody(template: string, params: Record<string, unknown>): string {
	return template.replace(PLACEHOLDER, (whole, name: string) =>
		name in params ? JSON.stringify(params[name] ?? null) : whole,
	);
}

const invalid = (message: string): never => {
	throw new ApiError("validation_error", message);
};

/** Everything that must hold before an HTTP tool is stored (§B.2). */
export function validateHttpTool(input: HttpToolInput): ValidatedHttpTool {
	const name = input.name.trim();
	if (!HTTP_TOOL_NAME_RE.test(name)) {
		invalid(
			`"${name}" is not a valid tool name: lowercase letters, digits and underscore, starting with a letter, 3–48 characters.`,
		);
	}
	if (input.description.trim().length < 10) {
		invalid(
			"The description is what the model reads to decide when to call this tool; write at least a sentence.",
		);
	}
	if (input.method !== "GET" && input.method !== "POST") invalid("Method must be GET or POST.");
	if (!/^https?:\/\//i.test(input.urlTemplate)) {
		invalid("The URL template must be an absolute http:// or https:// URL.");
	}
	if (input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS) {
		invalid(`The timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms.`);
	}

	const parameters = input.parameters ?? [];
	for (const param of parameters) {
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(param.name)) {
			invalid(`"${param.name}" is not a valid parameter name.`);
		}
	}
	const schema = input.parametersSchema ?? buildParametersSchema(parameters);
	if (typeof schema !== "object" || schema === null || schema.type !== "object") {
		invalid('The parameter schema must be a JSON-Schema object with `type: "object"`.');
	}
	const known = new Set(schemaParamNames(schema));

	for (const [what, template] of [
		["URL", input.urlTemplate],
		["body", input.method === "POST" ? (input.bodyTemplate ?? "") : ""],
	] as const) {
		for (const placeholder of placeholders(template)) {
			if (!known.has(placeholder)) {
				invalid(`The ${what} uses {${placeholder}}, which is not a declared parameter.`);
			}
		}
	}
	if (input.method === "POST" && input.bodyTemplate) {
		// The template is checked with placeholders replaced by a literal, so `{"q":{q}}` parses.
		const probe = input.bodyTemplate.replace(PLACEHOLDER, "null");
		try {
			JSON.parse(probe);
		} catch {
			invalid("The body template must be valid JSON once placeholders are substituted.");
		}
	}
	for (const key of Object.keys(input.headers)) {
		if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) invalid(`"${key}" is not a valid header name.`);
	}

	return {
		...input,
		name,
		label: (input.label ?? name).trim() || name,
		description: input.description.trim(),
		parameters,
		parametersSchema: schema,
	};
}
