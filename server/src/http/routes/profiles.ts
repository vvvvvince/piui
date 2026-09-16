// spec/09-api.md §4 (profiles + memory) and §6 (the M5 read half of the skills surface).
import type {
	CreateProfileRequest,
	DeleteProfileResponse,
	PatchProfileRequest,
	ProfileDetail,
	ProfileMemoryResponse,
	ProfilesResponse,
	SkillsResponse,
} from "@piui/shared";
import type { ProfileService } from "../../profiles/service.js";
import type { SkillCatalog } from "../../skills/catalog.js";
import type { PiuiFastify } from "../auth.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const PROFILE_BODY = {
	type: "object",
	additionalProperties: false,
	properties: {
		name: { type: "string", minLength: 1, maxLength: 60 },
		description: { type: "string", maxLength: 280 },
		agentsMd: { type: "string" },
		skillIds: { type: "array", items: { type: "string" } },
		toolNames: { type: "array", items: { type: "string" } },
		includeDiscoveredSkills: { type: "boolean" },
		memory: {
			type: "object",
			additionalProperties: false,
			required: ["enabled"],
			properties: { enabled: { type: "boolean" }, path: { type: ["string", "null"] } },
		},
		defaults: {
			type: "object",
			additionalProperties: false,
			properties: {
				provider: { type: "string" },
				modelId: { type: "string" },
				thinkingLevel: { type: "string", enum: THINKING_LEVELS },
			},
		},
	},
} as const;

export async function registerProfileRoutes(
	app: PiuiFastify,
	profiles: ProfileService,
	skills: SkillCatalog,
): Promise<void> {
	app.get("/api/profiles", async (req): Promise<ProfilesResponse> => {
		return { items: profiles.list(req.principal!) };
	});

	app.post<{ Body: CreateProfileRequest }>(
		"/api/profiles",
		{ schema: { body: { ...PROFILE_BODY, required: ["name"] } } },
		async (req, reply): Promise<ProfileDetail> => {
			reply.status(201);
			return profiles.create(req.principal!, req.body);
		},
	);

	app.get<{ Params: { id: string } }>(
		"/api/profiles/:id",
		async (req): Promise<ProfileDetail> => profiles.get(req.principal!, req.params.id),
	);

	app.patch<{ Params: { id: string }; Body: PatchProfileRequest }>(
		"/api/profiles/:id",
		{ schema: { body: PROFILE_BODY } },
		async (req): Promise<ProfileDetail> =>
			profiles.patch(req.principal!, req.params.id, req.body ?? {}),
	);

	app.delete<{ Params: { id: string } }>(
		"/api/profiles/:id",
		async (req): Promise<DeleteProfileResponse> => profiles.delete(req.principal!, req.params.id),
	);

	app.post<{ Params: { id: string } }>(
		"/api/profiles/:id/duplicate",
		async (req, reply): Promise<ProfileDetail> => {
			reply.status(201);
			return profiles.duplicate(req.principal!, req.params.id);
		},
	);

	// ------------------------------------------------------------- memory
	app.get<{ Params: { id: string } }>(
		"/api/profiles/:id/memory",
		async (req): Promise<ProfileMemoryResponse> =>
			profiles.readMemory(req.principal!, req.params.id),
	);

	app.put<{ Params: { id: string }; Body: { content: string } }>(
		"/api/profiles/:id/memory",
		{
			schema: {
				body: {
					type: "object",
					required: ["content"],
					additionalProperties: false,
					properties: { content: { type: "string" } },
				},
			},
		},
		async (req): Promise<{ sizeBytes: number }> =>
			profiles.writeMemory(req.principal!, req.params.id, req.body.content),
	);

	app.delete<{ Params: { id: string } }>("/api/profiles/:id/memory", async (req, reply) => {
		profiles.clearMemory(req.principal!, req.params.id);
		return reply.status(204).send();
	});

	app.get<{ Params: { id: string } }>("/api/profiles/:id/memory/download", async (req, reply) => {
		const memory = profiles.readMemory(req.principal!, req.params.id);
		reply.header("content-type", "text/markdown; charset=utf-8");
		reply.header("content-disposition", `attachment; filename="memory-${req.params.id}.md"`);
		return memory.content;
	});

	// -------------------------------------------------------------- skills
	// M5 ships the read path only; CRUD, import and test-run are M6.
	app.get("/api/skills", async (req): Promise<SkillsResponse> => {
		return { items: skills.list(req.principal!) };
	});
}
