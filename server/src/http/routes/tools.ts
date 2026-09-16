// spec/09-api.md §7 — the tool catalog. `PATCH /api/tools/:name` is admin-only through the
// global guard in http/authz.ts; HTTP-tool CRUD lands in M6.
import type { PatchToolRequest, SearchTestResponse, ToolsResponse } from "@piui/shared";
import type { AppContext } from "../../context.js";
import { ProviderNotConfiguredError } from "../../search/providers.js";
import type { Services } from "../../services.js";
import type { PiuiFastify } from "../auth.js";
import { ApiError } from "../errors.js";
import { SlidingWindowLimiter } from "../rate-limit.js";

/** The Test-search button is a free outbound request: rate limit it like /api/fs/browse. */
const TEST_SEARCHES_PER_MINUTE = 10;

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
