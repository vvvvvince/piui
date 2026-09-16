// spec/09-api.md §7 — the tool catalog. `PATCH /api/tools/:name` is admin-only through the
// global guard in http/authz.ts; HTTP-tool CRUD lands in M6.
import type {
	CreateHttpToolRequest,
	DeleteHttpToolResponse,
	HttpToolDetail,
	HttpToolTestResponse,
	PatchHttpToolRequest,
	PatchToolRequest,
	SearchTestResponse,
	ToolsResponse,
} from "@piui/shared";
import type { AppContext } from "../../context.js";
import { ProviderNotConfiguredError } from "../../search/providers.js";
import type { Services } from "../../services.js";
import type { PiuiFastify } from "../auth.js";
import { ApiError } from "../errors.js";
import { SlidingWindowLimiter } from "../rate-limit.js";

/** The Test-search button is a free outbound request: rate limit it like /api/fs/browse. */
const TEST_SEARCHES_PER_MINUTE = 10;

const HTTP_TOOL_BODY = {
	type: "object",
	additionalProperties: false,
	properties: {
		name: { type: "string", maxLength: 48 },
		label: { type: "string", maxLength: 80 },
		description: { type: "string", maxLength: 2000 },
		method: { type: "string", enum: ["GET", "POST"] },
		urlTemplate: { type: "string", maxLength: 2048 },
		headers: { type: "object", additionalProperties: { type: "string", maxLength: 4096 } },
		bodyTemplate: { type: ["string", "null"], maxLength: 8192 },
		parameters: {
			type: "array",
			maxItems: 32,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["name", "type", "required"],
				properties: {
					name: { type: "string", maxLength: 48 },
					type: { type: "string", enum: ["string", "number", "boolean", "string[]"] },
					required: { type: "boolean" },
					description: { type: "string", maxLength: 500 },
				},
			},
		},
		parametersSchema: { type: "object" },
		timeoutMs: { type: "integer" },
		enabled: { type: "boolean" },
	},
} as const;

export async function registerToolRoutes(
	app: PiuiFastify,
	ctx: AppContext,
	services: Services,
): Promise<void> {
	const testLimiter = new SlidingWindowLimiter(
		() => ctx.clock.nowMs(),
		TEST_SEARCHES_PER_MINUTE,
		60_000,
	);

	app.get("/api/tools", async (): Promise<ToolsResponse> => {
		return { items: services.tools.list(), webSearch: services.tools.searchStatus };
	});

	// ------------------------------------------------- HTTP tools (spec §B.2)
	// The whole `/api/tools/http` surface is admin-only (http/authz.ts): an HTTP tool makes
	// outbound calls from this host with server-side secrets, the same blast radius as an
	// extension. 18-multi-user.md §5 names only `PATCH /api/tools/:name`; this is the stricter
	// reading, recorded in plan/milestone-notes.md.
	app.get("/api/tools/http", async (req): Promise<{ items: HttpToolDetail[] }> => {
		return { items: services.httpTools.list(req.principal!) };
	});

	app.post<{ Body: CreateHttpToolRequest }>(
		"/api/tools/http",
		{ schema: { body: HTTP_TOOL_BODY } },
		async (req, reply): Promise<HttpToolDetail> => {
			const created = services.httpTools.create(req.principal!, req.body);
			req.log.info(
				{ event: "http_tool_create", tool: created.name, actor: req.principal?.id },
				"http_tool_create",
			);
			reply.status(201);
			return created;
		},
	);

	app.get<{ Params: { id: string } }>(
		"/api/tools/http/:id",
		async (req): Promise<HttpToolDetail> => services.httpTools.get(req.principal!, req.params.id),
	);

	app.patch<{ Params: { id: string }; Body: PatchHttpToolRequest }>(
		"/api/tools/http/:id",
		{ schema: { body: HTTP_TOOL_BODY } },
		async (req): Promise<HttpToolDetail> => {
			const updated = services.httpTools.patch(req.principal!, req.params.id, req.body ?? {});
			req.log.info(
				{ event: "http_tool_update", tool: updated.name, actor: req.principal?.id },
				"http_tool_update",
			);
			return updated;
		},
	);

	app.delete<{ Params: { id: string } }>(
		"/api/tools/http/:id",
		async (req): Promise<DeleteHttpToolResponse> => {
			const result = services.httpTools.remove(req.principal!, req.params.id);
			req.log.info(
				{ event: "http_tool_delete", tool: req.params.id, actor: req.principal?.id },
				"http_tool_delete",
			);
			return result;
		},
	);

	app.post<{ Params: { id: string }; Body: { params?: Record<string, unknown> } }>(
		"/api/tools/http/:id/test",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					properties: { params: { type: "object" } },
				},
			},
		},
		async (req): Promise<HttpToolTestResponse> => {
			if (!testLimiter.take(req.sessionId ?? req.ip)) {
				throw new ApiError("rate_limited", "Too many tool tests. Try again in a minute.");
			}
			return services.httpTools.test(req.principal!, req.params.id, req.body?.params ?? {});
		},
	);

	app.patch<{ Params: { name: string }; Body: PatchToolRequest }>(
		"/api/tools/:name",
		{
			schema: {
				body: {
					type: "object",
					properties: { enabled: { type: "boolean" } },
					required: ["enabled"],
					additionalProperties: false,
				},
			},
		},
		async (req) => {
			const { name } = req.params;
			if (!services.tools.knows(name)) {
				throw new ApiError("not_found", `No tool named "${name}".`);
			}
			const descriptor = services.tools.setEnabled(name, req.body.enabled);
			req.log.info(
				{ event: "tool_toggle", tool: name, enabled: req.body.enabled, actor: req.principal?.id },
				"tool_toggle",
			);
			return descriptor;
		},
	);

	app.post<{ Body: { query: string } }>(
		"/api/tools/web_search/test",
		{
			schema: {
				body: {
					type: "object",
					properties: { query: { type: "string", minLength: 1, maxLength: 400 } },
					required: ["query"],
					additionalProperties: false,
				},
			},
		},
		async (req): Promise<SearchTestResponse> => {
			if (!testLimiter.take(req.sessionId ?? req.ip)) {
				throw new ApiError("rate_limited", "Too many test searches. Try again in a minute.");
			}
			try {
				const results = await services.search.search(req.body.query, { count: 3 });
				return { provider: services.search.id, results };
			} catch (error) {
				if (error instanceof ProviderNotConfiguredError) {
					throw new ApiError(
						"provider_not_configured",
						"No web-search provider is configured on this server (PIUI_SEARCH_PROVIDER / PIUI_SEARCH_API_KEY).",
					);
				}
				throw new ApiError("internal_error", (error as Error).message);
			}
		},
	);
}
