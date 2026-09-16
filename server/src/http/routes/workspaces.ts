// spec/09-api.md §5 — the workspace surface plus the directory picker.
// `GET /api/fs/browse` is admin-only through the matcher in http/authz.ts.
import type {
	CreateWorkspaceRequest,
	DeleteWorkspaceResponse,
	FsBrowseResponse,
	PatchWorkspaceRequest,
	ValidatePathRequest,
	ValidatePathResponse,
	Workspace,
	WorkspaceFileResponse,
	WorkspaceGitResponse,
	WorkspacesResponse,
	WorkspaceTreeResponse,
} from "@piui/shared";
import type { WorkspaceService } from "../../workspaces/service.js";
import type { PiuiFastify } from "../auth.js";
import { ApiError } from "../errors.js";

const NAME = { type: "string", minLength: 1, maxLength: 60 } as const;
const DESCRIPTION = { type: "string", maxLength: 280 } as const;
const PATH = { type: "string", minLength: 1, maxLength: 4096 } as const;

export async function registerWorkspaceRoutes(
	app: PiuiFastify,
	workspaces: WorkspaceService,
): Promise<void> {
	app.get("/api/workspaces", async (req): Promise<WorkspacesResponse> => {
		return { items: workspaces.list(req.principal!) };
	});

	app.post<{ Body: CreateWorkspaceRequest }>(
		"/api/workspaces",
		{
			schema: {
				body: {
					type: "object",
					properties: {
						name: NAME,
						path: PATH,
						description: DESCRIPTION,
						create: { type: "boolean" },
						gitInit: { type: "boolean" },
					},
					required: ["name", "path"],
					additionalProperties: false,
				},
			},
		},
		async (req, reply): Promise<Workspace> => {
			const workspace = workspaces.create(req.principal!, req.body);
			reply.status(201);
			return workspace;
		},
	);

	// before /:id, or "validate" would be read as an id
	app.post<{ Body: ValidatePathRequest }>(
		"/api/workspaces/validate",
		{
			schema: {
				body: {
					type: "object",
					properties: { path: PATH, create: { type: "boolean" } },
					required: ["path"],
					additionalProperties: false,
				},
			},
		},
		async (req): Promise<ValidatePathResponse> => workspaces.validate(req.body),
	);

	app.get<{ Params: { id: string } }>(
		"/api/workspaces/:id",
		async (req): Promise<Workspace> => workspaces.get(req.principal!, req.params.id),
	);

	app.patch<{ Params: { id: string }; Body: PatchWorkspaceRequest }>(
		"/api/workspaces/:id",
		{
			schema: {
				body: {
					type: "object",
					properties: {
						name: NAME,
						description: DESCRIPTION,
						path: PATH,
						trusted: { type: "boolean" },
					},
					additionalProperties: false,
				},
			},
		},
		async (req): Promise<Workspace> => workspaces.patch(req.principal!, req.params.id, req.body),
	);

	app.delete<{ Params: { id: string } }>(
		"/api/workspaces/:id",
		async (req): Promise<DeleteWorkspaceResponse> =>
			workspaces.delete(req.principal!, req.params.id),
	);

	app.get<{ Params: { id: string }; Querystring: { path?: string; depth?: string } }>(
		"/api/workspaces/:id/tree",
		async (req): Promise<WorkspaceTreeResponse> =>
			workspaces.tree(
				req.principal!,
				req.params.id,
				req.query.path ?? "",
				Number(req.query.depth ?? 1),
			),
	);

	app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
		"/api/workspaces/:id/file",
		async (req): Promise<WorkspaceFileResponse> => {
			if (!req.query.path) throw new ApiError("validation_error", "A `path` is required.");
			return workspaces.file(req.principal!, req.params.id, req.query.path);
		},
	);

	app.get<{ Params: { id: string } }>(
		"/api/workspaces/:id/git",
		async (req): Promise<WorkspaceGitResponse> =>
			workspaces.gitStatus(req.principal!, req.params.id),
	);

	app.get<{ Querystring: { path?: string } }>(
		"/api/fs/browse",
		async (req): Promise<FsBrowseResponse> => workspaces.browse(req.query.path),
	);
}
