// HTTP-tool CRUD and the Test button. spec/05-skills-and-tools.md §B.2, spec/09-api.md §7.
//
// Header values are stored as typed (`${ENV_VAR}` references, ideally) and are **never** returned:
// every read answers `"***"`. The test endpoint echoes the response, never the request headers.
import type {
	CreateHttpToolRequest,
	DeleteHttpToolResponse,
	HttpToolDetail,
	HttpToolParam,
	HttpToolTestResponse,
	PatchHttpToolRequest,
	Principal,
} from "@piui/shared";
import type { AppContext } from "../context.js";
import type { HttpToolRow } from "../db/repositories/http-tools.js";
import { ApiError } from "../http/errors.js";
import { createHttpTool, type HttpToolDefinition } from "../pi/tools/http-tool.js";
import { validateHttpTool } from "./http-tools.js";
import type { ToolRegistry } from "./registry.js";

/** What a read of a stored header value returns, always (§B.2). */
export const MASKED = "***";

export class HttpToolService {
	constructor(
		private readonly ctx: AppContext,
		private readonly registry: () => ToolRegistry,
		private readonly deps: { onChanged?(): void } = {},
	) {}

	list(principal: Principal): HttpToolDetail[] {
		return this.ctx.repos.httpTools.list(principal).map((row) => this.view(row));
	}

	get(principal: Principal, id: string): HttpToolDetail {
		return this.view(this.rowOrThrow(principal, id));
	}

	create(principal: Principal, body: CreateHttpToolRequest): HttpToolDetail {
		const validated = validateHttpTool(this.merge(undefined, body));
		this.assertNameFree(validated.name, undefined);
		const row = this.ctx.repos.httpTools.insert(principal.id, {
			...validated,
			parameters: { parameters: validated.parameters, schema: validated.parametersSchema },
			...(body.enabled === undefined ? {} : { enabled: body.enabled }),
		});
		this.deps.onChanged?.();
		return this.view(row);
	}

	patch(principal: Principal, id: string, body: PatchHttpToolRequest): HttpToolDetail {
		const row = this.rowOrThrow(principal, id);
		const validated = validateHttpTool(this.merge(row, body));
		this.assertNameFree(validated.name, row.id);
		if (validated.name !== row.name) this.ctx.repos.httpTools.forgetToolName(row.name);
		const updated = this.ctx.repos.httpTools.update(id, {
			...validated,
			parameters: { parameters: validated.parameters, schema: validated.parametersSchema },
			enabled: body.enabled ?? row.enabled === 1,
		});
		this.deps.onChanged?.();
		return this.view(updated);
	}

	remove(principal: Principal, id: string): DeleteHttpToolResponse {
		const row = this.rowOrThrow(principal, id);
		const affectedProfiles = this.ctx.repos.httpTools.profilesUsing(row.name);
		this.ctx.repos.httpTools.delete(id);
		this.ctx.repos.httpTools.forgetToolName(row.name);
		this.deps.onChanged?.();
		return { affectedProfiles };
	}

	/** The Test button: one real call through the same runtime, truncated to 8 KB (§B.2). */
	async test(
		principal: Principal,
		id: string,
		params: Record<string, unknown>,
	): Promise<HttpToolTestResponse> {
		const row = this.rowOrThrow(principal, id);
		const startedAt = this.ctx.clock.nowMs();
		const tool = this.runtimeToolOf(row);
		try {
			const result = (await tool.execute(
				"test",
				params as never,
				undefined,
				undefined as never,
				undefined as never,
			)) as { content: { text: string }[]; details: { status: number; durationMs: number } };
			const body = result.content.map((part) => part.text).join("");
			return {
				status: result.details.status,
				durationMs: result.details.durationMs,
				body: body.slice(0, 8192),
				truncated: body.length > 8192,
			};
		} catch (error) {
			const message = (error as Error).message;
			// A non-2xx and a refusal both arrive as an error; the client renders the body.
			const status = /HTTP (\d{3})/.exec(message)?.[1];
			if (!status) throw new ApiError("validation_error", message);
			return {
				status: Number(status),
				durationMs: Math.max(0, this.ctx.clock.nowMs() - startedAt),
				body: message.slice(0, 8192),
				truncated: message.length > 8192,
			};
		}
	}

	// --------------------------------------------------- session construction

	/** The pi custom tools for the names a conversation resolved (spec §B.4). */
	toolsFor(names: readonly string[]): unknown[] {
		const wanted = new Set(names);
		return this.ctx.repos.httpTools
			.all()
			.filter((row) => row.enabled === 1 && wanted.has(row.name))
			.map((row) => this.runtimeToolOf(row));
	}

	/** The catalog rows contributed by `http_tools` (spec §B.1, kind 3). */
	catalogItems(): {
		name: string;
		label: string;
		description: string;
		enabled: boolean;
	}[] {
		return this.ctx.repos.httpTools.all().map((row) => ({
			name: row.name,
			label: row.label,
			description: row.description,
			enabled: row.enabled === 1,
		}));
	}

	// ----------------------------------------------------------------- parts

	private runtimeToolOf(row: HttpToolRow) {
		return createHttpTool({
			definition: definitionOf(row),
			fetch: (url, init) => this.ctx.fetch(url as string, init),
			lookup: (hostname) => this.ctx.lookup(hostname),
			// The only env read outside config.ts would be illegal: config.ts owns the reader.
			env: this.ctx.config.readEnv,
			allowPrivate: this.ctx.config.allowPrivateHttpTools,
			nowMs: () => this.ctx.clock.nowMs(),
		});
	}

	private rowOrThrow(principal: Principal, id: string): HttpToolRow {
		const row = this.ctx.repos.httpTools.get(principal, id);
		if (!row) throw new ApiError("not_found", `No HTTP tool ${id}.`);
		return row;
	}

	/** §B.2 — unique across the **whole** catalog, including built-ins and extension tools. */
	private assertNameFree(name: string, selfId: string | undefined): void {
		const existing = this.ctx.repos.httpTools.findByName(name);
		if (existing && existing.id !== selfId) {
			throw new ApiError("tool_name_taken", `A tool named "${name}" already exists.`);
		}
		const inCatalog = this.registry()
			.list()
			.find((item) => item.name === name);
		if (inCatalog && inCatalog.kind !== "http") {
			throw new ApiError(
				"tool_name_taken",
				`"${name}" is already the name of a ${inCatalog.kind === "extension" ? "tool registered by an extension" : "built-in tool"}.`,
			);
		}
	}

	/** A PATCH keeps every field it does not mention — including unsent header values. */
	private merge(
		row: HttpToolRow | undefined,
		body: CreateHttpToolRequest | PatchHttpToolRequest,
	): Parameters<typeof validateHttpTool>[0] {
		const stored = row ? parseParams(row.params_json) : { parameters: [], schema: undefined };
		const headers = row ? (JSON.parse(row.headers_json) as Record<string, string>) : {};
		if (body.headers) {
			for (const [key, value] of Object.entries(body.headers)) {
				// "" deletes, MASKED means "keep what is stored", anything else replaces.
				if (value === "") delete headers[key];
				else if (value !== MASKED) headers[key] = value;
			}
			for (const key of Object.keys(headers)) {
				if (!(key in body.headers)) delete headers[key];
			}
		}
		const parameters = body.parameters ?? stored.parameters;
		return {
			name: body.name ?? row?.name ?? "",
			label: body.label ?? row?.label,
			description: body.description ?? row?.description ?? "",
			method: (body.method ?? row?.method ?? "GET") as "GET" | "POST",
			urlTemplate: body.urlTemplate ?? row?.url_template ?? "",
			headers,
			bodyTemplate:
				body.bodyTemplate === undefined ? (row?.body_template ?? null) : body.bodyTemplate,
			parameters,
			...(body.parametersSchema
				? { parametersSchema: body.parametersSchema }
				: body.parameters
					? {}
					: stored.schema
						? { parametersSchema: stored.schema }
						: {}),
			timeoutMs: body.timeoutMs ?? row?.timeout_ms ?? 20_000,
		};
	}

	private view(row: HttpToolRow): HttpToolDetail {
		const stored = parseParams(row.params_json);
		const headers = JSON.parse(row.headers_json) as Record<string, string>;
		return {
			id: row.id,
			name: row.name,
			label: row.label,
			description: row.description,
			enabled: row.enabled === 1,
			method: row.method as "GET" | "POST",
			urlTemplate: row.url_template,
			// §B.2: a stored header value can never be read back through any route.
			headers: Object.fromEntries(Object.keys(headers).map((key) => [key, MASKED])),
			bodyTemplate: row.body_template,
			parameters: stored.parameters,
			parametersSchema: stored.schema ?? { type: "object", properties: {} },
			timeoutMs: row.timeout_ms,
			usedByProfiles: this.ctx.repos.httpTools.profilesUsing(row.name).length,
		};
	}
}

export function definitionOf(row: HttpToolRow): HttpToolDefinition {
	const stored = parseParams(row.params_json);
	return {
		id: row.id,
		name: row.name,
		label: row.label,
		description: row.description,
		method: row.method as "GET" | "POST",
		urlTemplate: row.url_template,
		headers: JSON.parse(row.headers_json) as Record<string, string>,
		bodyTemplate: row.body_template,
		parametersSchema: stored.schema ?? { type: "object", properties: {} },
		timeoutMs: row.timeout_ms,
	};
}

function parseParams(json: string): {
	parameters: HttpToolParam[];
	schema: Record<string, unknown> | undefined;
} {
	try {
		const parsed = JSON.parse(json) as {
			parameters?: HttpToolParam[];
			schema?: Record<string, unknown>;
		};
		return { parameters: parsed.parameters ?? [], schema: parsed.schema };
	} catch {
		return { parameters: [], schema: undefined };
	}
}
