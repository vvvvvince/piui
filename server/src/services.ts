// Everything that lives for the whole process and is shared by routes: the pi model runtime
// and the services built on it. Created by buildServer, disposed on shutdown.

import { CommandService } from "./commands/service.js";
import type { AppContext } from "./context.js";
import { ConversationService } from "./conversations/service.js";
import { ExtensionService } from "./extensions/service.js";
import { installedBuiltinToolNames } from "./pi/builtin-tools.js";
import { CredentialService } from "./pi/credentials.js";
import type { FakeModelHandle } from "./pi/fake-model.js";
import { ModelService } from "./pi/model-service.js";
import { createPiRuntime, type ModelRuntime } from "./pi/runtime.js";
import { createWebTools, type WebToolSet } from "./pi/tools/web-search.js";
import { MemoryStore } from "./profiles/memory.js";
import { ProfileService } from "./profiles/service.js";
import { createSearchProvider, type WebSearchProvider } from "./search/providers.js";
import { GlobalEventBus } from "./session/bus.js";
import { SessionHub } from "./session/hub.js";
import { SkillCatalog } from "./skills/catalog.js";
import { SkillService } from "./skills/service.js";
import { SkillTestRunner } from "./skills/test-run.js";
import { HttpToolService } from "./tools/http-tool-service.js";
import { ToolRegistry } from "./tools/registry.js";
import { UploadService } from "./uploads/service.js";
import { WorkspaceService } from "./workspaces/service.js";

export interface Services {
	modelRuntime: ModelRuntime;
	credentials: CredentialService;
	models: ModelService;
	events: GlobalEventBus;
	hub: SessionHub;
	conversations: ConversationService;
	/** The `/` command surface and prompt-template composition (spec/15 §§1-3). */
	commands: CommandService;
	/** Extension enumeration, install flows and resolution (spec/16 §§2-4). */
	extensions: ExtensionService;
	profiles: ProfileService;
	skills: SkillCatalog;
	/** The skill write path: CRUD, per-file routes, import and validation (spec/05 §§A.2-A.5). */
	skillWrites: SkillService;
	/** `POST /api/skills/:id/test` — the ephemeral test conversation (spec/05 §A.4). */
	skillTests: SkillTestRunner;
	/** The per-profile memory file store; owns the append mutex. */
	memory: MemoryStore;
	/** The configured web-search provider (`none` when unset). */
	search: WebSearchProvider;
	tools: ToolRegistry;
	/** Image uploads: magic-byte validation, storage and inline serving (spec/09-api.md §10). */
	uploads: UploadService;
	/** User-defined HTTP tools: CRUD, the test call and the runtime factory (spec/05 §B.2). */
	httpTools: HttpToolService;
	workspaces: WorkspaceService;
	/** One tool set per pi session: the per-run search budget lives in it. */
	createWebToolSet(): WebToolSet;
	fakeModel?: FakeModelHandle;
	dispose(): Promise<void>;
}

export async function createServices(ctx: AppContext): Promise<Services> {
	const { runtime, fakeModel } = await createPiRuntime(ctx.config);
	const events = new GlobalEventBus();
	const search = createSearchProvider({
		config: {
			searchProvider: ctx.config.searchProvider,
			searchApiKey: ctx.config.searchApiKey,
			searxngUrl: ctx.config.searxngUrl,
		},
		fetch: ctx.fetch,
		nowMs: () => ctx.clock.nowMs(),
	});
	const extensions = new ExtensionService(ctx, {
		// spec/16-extensions.md §7.3: changes apply to **new** conversations, so live sessions are
		// deliberately not dropped (a dropped session would lose its pending ui_requests).
		onChanged: () => events.emit({ type: "extensions_changed" }),
	});
	const httpTools: HttpToolService = new HttpToolService(ctx, () => tools, {
		onChanged: () => events.emit({ type: "skills_changed" }),
	});
	const tools: ToolRegistry = new ToolRegistry({
		repos: ctx.repos,
		search,
		logger: ctx.logger,
		extensions,
		httpTools,
	});
	tools.validateAgainstPi(installedBuiltinToolNames());
	const skills = new SkillCatalog(ctx);
	const skillWrites = new SkillService(ctx, skills, {
		// The command surface and every session's ResourceLoader hold the skill set.
		onChanged: () => events.emit({ type: "skills_changed" }),
	});
	const memory = new MemoryStore();
	const profiles = new ProfileService(ctx, { tools, skills, memory, extensions });
	profiles.seedIfEmpty();
	const models = new ModelService({ runtime, nowMs: () => ctx.clock.nowMs() });
	const credentials = new CredentialService({
		runtime,
		authPath: ctx.config.piAuthPath,
		ids: ctx.ids,
		nowMs: () => ctx.clock.nowMs(),
		logger: ctx.logger,
		onMutation: () => {
			models.invalidate();
			events.emit({ type: "providers_changed" });
		},
	});

	// The hub and the conversation service are mutually recursive: the hub builds pi sessions
	// through the service, the service reads live state from the hub.
	const hub = new SessionHub({
		createSession: (conversationId) => services.conversations.createPiSession(conversationId),
		events,
		nowMs: () => ctx.clock.nowMs(),
		maxConcurrentRuns: ctx.config.maxConcurrentRuns,
		maxRunMinutes: ctx.config.maxRunMinutes,
		maxToolCallsPerRun: ctx.config.maxToolCallsPerRun,
		onRunEnd: (conversationId, session) =>
			services.conversations.recordRunEnd(conversationId, session),
	});

	const services: Services = {
		modelRuntime: runtime,
		credentials,
		models,
		events,
		hub,
		search,
		tools,
		httpTools,
		uploads: new UploadService(ctx),
		extensions,
		profiles,
		skills,
		skillWrites,
		skillTests: new SkillTestRunner(ctx, () => services),
		memory,
		workspaces: new WorkspaceService(ctx, {
			onTrustChanged: (workspaceId) => {
				for (const id of ctx.repos.conversations.idsInWorkspace(workspaceId)) hub.drop(id);
				events.emit({ type: "skills_changed" });
			},
		}),
		commands: new CommandService(ctx, {
			skills,
			profiles,
			extensions,
			// A rescan changes what every session's ResourceLoader holds.
			onRescan: () => {
				hub.dropAll();
				events.emit({ type: "skills_changed" });
			},
		}),
		createWebToolSet: () =>
			createWebTools({
				provider: search,
				fetch: ctx.fetch,
				allowPrivate: ctx.config.allowPrivateHttpTools,
			}),
		// replaced immediately below, once the service can see `services`
		conversations: undefined as unknown as ConversationService,
		...(fakeModel ? { fakeModel } : {}),
		async dispose() {
			credentials.dispose();
			await hub.disposeAll();
		},
	};
	services.conversations = new ConversationService(ctx, services, hub);
	services.conversations.sweepScratch();
	return services;
}
