// spec/09-api.md §7b / spec/16-extensions.md §9. The whole prefix is admin-only and step-up
// gated through the matchers in http/authz.ts; every mutation is audit-logged (§7.4.5).
import { createHash } from "node:crypto";
import type {
	CreateExtensionRequest,
	DeleteExtensionResponse,
	ExtensionDetail,
	ExtensionRescanResponse,
	ExtensionSummary,
	ExtensionsResponse,
	FetchExtensionRequest,
	FetchExtensionResponse,
	PatchExtensionRequest,
} from "@piui/shared";
import type { ExtensionService } from "../../extensions/service.js";
import type { PiuiFastify } from "../auth.js";

export async function registerExtensionRoutes(
	app: PiuiFastify,
	extensions: ExtensionService,
): Promise<void> {
	app.get("/api/extensions", async (): Promise<ExtensionsResponse> => extensions.list());

	app.get<{ Params: { id: string } }>(
		"/api/extensions/:id",
		async (req): Promise<ExtensionDetail> => extensions.get(req.params.id),
	);

	app.post<{ Body: CreateExtensionRequest }>(
		"/api/extensions",
		{
			// The 1 MB cap is the service's (`extension_too_large`); the transport must not turn it
			// into a generic 413 before the domain sees it.
			bodyLimit: 4 * 1024 * 1024,
			schema: {
				body: {
					type: "object",
					properties: {
						name: { type: "string", maxLength: 64 },
						source: { type: "string" },
						path: { type: "string" },
						origin: { type: "string", maxLength: 2048 },
					},
					additionalProperties: false,
				},
			},
		},
		async (req, reply): Promise<ExtensionSummary> => {
			const created = await extensions.install(req.body);
			req.log.info(
				{
					event: "extension_install",
					extension: created.name,
					origin: req.body.origin ?? req.body.path ?? "paste",
					sha256: req.body.source
						? createHash("sha256").update(req.body.source).digest("hex")
						: undefined,
					actor: req.principal?.id,
				},
				"extension_install",
			);
			reply.code(201);
			return created;
		},
	);

	app.post<{ Body: FetchExtensionRequest }>(
		"/api/extensions/fetch",
		{
			schema: {
				body: {
					type: "object",
					properties: { url: { type: "string", minLength: 1, maxLength: 2048 } },
					required: ["url"],
					additionalProperties: false,
				},
			},
		},
		async (req): Promise<FetchExtensionResponse> => extensions.fetchSource(req.body.url),
	);

	app.patch<{ Params: { id: string }; Body: PatchExtensionRequest }>(
		"/api/extensions/:id",
		{
			bodyLimit: 4 * 1024 * 1024,
			schema: {
				body: {
					type: "object",
					properties: { enabled: { type: "boolean" }, source: { type: "string" } },
					additionalProperties: false,
				},
			},
		},
		async (req): Promise<ExtensionSummary> => {
			const updated = await extensions.patch(req.params.id, req.body);
			req.log.info(
				{
					event: req.body.source === undefined ? "extension_toggle" : "extension_update",
					extension: updated.name,
					enabled: updated.enabled,
					actor: req.principal?.id,
				},
				"extension_mutation",
			);
			return updated;
		},
	);

	app.delete<{ Params: { id: string } }>(
		"/api/extensions/:id",
		async (req): Promise<DeleteExtensionResponse> => {
			const removed = await extensions.remove(req.params.id);
			req.log.info(
				{ event: "extension_uninstall", extension: req.params.id, actor: req.principal?.id },
				"extension_uninstall",
			);
			return removed;
		},
	);

	app.post(
		"/api/extensions/rescan",
		async (): Promise<ExtensionRescanResponse> => extensions.rescan(),
	);
}
