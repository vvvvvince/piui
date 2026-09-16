// Everything that lives for the whole process and is shared by routes: the pi model runtime
// and the services built on it. Created by buildServer, disposed on shutdown.

import { CommandService } from "./commands/service.js";
import type { AppContext } from "./context.js";
import { ConversationService } from "./conversations/service.js";
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
import { ToolRegistry } from "./tools/registry.js";
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
	profiles: ProfileService;
	skills: SkillCatalog;
	/** The per-profile memory file store; owns the append mutex. */
	memory: MemoryStore;
	/** The configured web-search provider (`none` when unset). */
	search: WebSearchProvider;
	tools: ToolRegistry;
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
	const tools = new ToolRegistry({ repos: ctx.repos, search, logger: ctx.logger });
	tools.validateAgainstPi(installedBuiltinToolNames());
	const skills = new SkillCatalog(ctx);
	const memory = new MemoryStore();
	const profiles = new ProfileService(ctx, { tools, skills, memory });
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
		profiles,
		skills,
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
