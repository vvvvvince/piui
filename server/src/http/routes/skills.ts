// spec/09-api.md §6 — the skills surface. `POST /api/skills/rescan` is admin-only through the
// `*/rescan` matcher in http/authz.ts; everything else is owner-scoped like profiles.
import type {
	CreateSkillRequest,
	DeleteSkillResponse,
	ImportSkillRequest,
	PatchSkillRequest,
	PutSkillFileRequest,
	SkillDetail,
	SkillFileEntry,
	SkillFileResponse,
	SkillRescanResponse,
	SkillSummary,
	SkillsResponse,
	SkillTestRequest,
	SkillTestResponse,
	SkillValidation,
} from "@piui/shared";
import type { AppContext } from "../../context.js";
import type { SkillService } from "../../skills/service.js";
import type { SkillTestRunner } from "../../skills/test-run.js";
import type { PiuiFastify } from "../auth.js";
import { ApiError } from "../errors.js";

const SKILL_BODY = {
	type: "object",
	additionalProperties: false,
	properties: {
		name: { type: "string", minLength: 1, maxLength: 64 },
		description: { type: "string", maxLength: 4096 },
		body: { type: "string" },
		enabled: { type: "boolean" },
		raw: { type: "string" },
		template: { type: "string", enum: ["basic", "script", "reference"] },
	},
} as const;

export async function registerSkillRoutes(
	app: PiuiFastify,
	ctx: AppContext,
	skills: SkillService,
	testRunner: SkillTestRunner,
): Promise<void> {
	app.get("/api/skills", async (req): Promise<SkillsResponse> => {
		return { items: skills.list(req.principal!) };
	});

	app.post<{ Body: CreateSkillRequest }>(
		"/api/skills",
		{ schema: { body: { ...SKILL_BODY, required: ["name", "description"] } } },
		async (req, reply): Promise<SkillSummary> => {
			const created = skills.create(req.principal!, req.body);
			req.log.info(
				{ event: "skill_create", skill: created.dirName, actor: req.principal?.id },
				"skill_create",
			);
			reply.status(201);
			return created;
		},
	);

	// `/api/skills/rescan` must be matched before `/api/skills/:id`-shaped routes.
	app.post("/api/skills/rescan", async (req): Promise<SkillRescanResponse> => {
		const result = skills.rescan();
		req.log.info({ event: "skill_rescan", ...result, actor: req.principal?.id }, "skill_rescan");
		return result;
	});

	app.post<{ Body: ImportSkillRequest }>(
		"/api/skills/import",
		{
			// The zip cap is the domain's, so the transport must let a big body through to it.
			bodyLimit: 64 * 1024 * 1024,
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					properties: { path: { type: "string" }, skillMd: { type: "string" } },
				},
			},
		},
		async (req, reply): Promise<SkillSummary> => {
			const created = req.body?.path
				? skills.importPath(req.principal!, req.body.path)
				: skills.importSkillMd(req.principal!, req.body?.skillMd ?? "");
			req.log.info(
				{
					event: "skill_import",
					kind: req.body?.path ? "path" : "paste",
					skill: created.dirName,
					actor: req.principal?.id,
				},
				"skill_import",
			);
			reply.status(201);
			return created;
		},
	);

	/** multipart `.zip` — the same route, content-type switched (spec/09-api.md §6). */
	app.post(
		"/api/skills/import-zip",
		{ bodyLimit: 64 * 1024 * 1024 },
		async (req, reply): Promise<SkillSummary> => {
			const file = await (
				req as unknown as { file(): Promise<{ toBuffer(): Promise<Buffer> } | undefined> }
			).file();
			if (!file) throw new ApiError("validation_error", "Attach a .zip file in the `file` field.");
			const created = skills.importZip(req.principal!, await file.toBuffer());
			req.log.info(
				{ event: "skill_import", kind: "zip", skill: created.dirName, actor: req.principal?.id },
				"skill_import",
			);
			reply.status(201);
			return created;
		},
	);

	app.get<{ Params: { id: string } }>(
		"/api/skills/:id",
		async (req): Promise<SkillDetail> => skills.detail(req.principal!, req.params.id),
	);

	app.patch<{ Params: { id: string }; Body: PatchSkillRequest }>(
		"/api/skills/:id",
		{ schema: { body: SKILL_BODY }, bodyLimit: 4 * 1024 * 1024 },
		async (req): Promise<SkillSummary> => {
			const updated = skills.patch(req.principal!, req.params.id, req.body ?? {});
			req.log.info(
				{ event: "skill_update", skill: updated.dirName, actor: req.principal?.id },
				"skill_update",
			);
			return updated;
		},
	);

	app.delete<{ Params: { id: string } }>(
		"/api/skills/:id",
		async (req): Promise<DeleteSkillResponse> => {
			const result = skills.remove(req.principal!, req.params.id);
			req.log.info(
				{ event: "skill_delete", skill: req.params.id, actor: req.principal?.id },
				"skill_delete",
			);
			return result;
		},
	);

	app.post<{ Params: { id: string } }>(
		"/api/skills/:id/validate",
		async (req): Promise<SkillValidation> =>
			skills.validate(skills.rowOrThrow(req.principal!, req.params.id)),
	);

	app.post<{ Params: { id: string }; Body: SkillTestRequest }>(
		"/api/skills/:id/test",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					properties: {
						allowBash: { type: "boolean" },
						provider: { type: "string" },
						modelId: { type: "string" },
					},
				},
			},
		},
		async (req, reply): Promise<SkillTestResponse> => {
			const result = await testRunner.start(req.principal!, req.params.id, req.body ?? {});
			reply.status(201);
			return result;
		},
	);

	// ----------------------------------------------------------- per file
	app.get<{ Params: { id: string; "*": string } }>(
		"/api/skills/:id/files/*",
		async (req): Promise<SkillFileResponse> => {
			const path = req.params["*"];
			const file = skills.readFile(req.principal!, req.params.id, path);
			return { path, content: file.content, size: file.size };
		},
	);

	app.put<{ Params: { id: string; "*": string }; Body: PutSkillFileRequest }>(
		"/api/skills/:id/files/*",
		{
			bodyLimit: 4 * 1024 * 1024,
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["content"],
					properties: { content: { type: "string" } },
				},
			},
		},
		async (req): Promise<SkillFileEntry> =>
			skills.writeFile(req.principal!, req.params.id, req.params["*"], req.body.content),
	);

	app.delete<{ Params: { id: string; "*": string } }>(
		"/api/skills/:id/files/*",
		async (req): Promise<{ ok: true }> => {
			skills.deleteFile(req.principal!, req.params.id, req.params["*"]);
			return { ok: true };
		},
	);

	void ctx;
}
