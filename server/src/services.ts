// Everything that lives for the whole process and is shared by routes: the pi model runtime
// and the services built on it. Created by buildServer, disposed on shutdown.

import type { AppContext } from "./context.js";
import { ConversationService } from "./conversations/service.js";
import { CredentialService } from "./pi/credentials.js";
import type { FakeModelHandle } from "./pi/fake-model.js";
import { ModelService } from "./pi/model-service.js";
import { createPiRuntime, type ModelRuntime } from "./pi/runtime.js";
import { GlobalEventBus } from "./session/bus.js";
import { SessionHub } from "./session/hub.js";

export interface Services {
	modelRuntime: ModelRuntime;
	credentials: CredentialService;
	models: ModelService;
	events: GlobalEventBus;
	hub: SessionHub;
	conversations: ConversationService;
	fakeModel?: FakeModelHandle;
	dispose(): Promise<void>;
}

export async function createServices(ctx: AppContext): Promise<Services> {
	const { runtime, fakeModel } = await createPiRuntime(ctx.config);
	const events = new GlobalEventBus();
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
		onRunEnd: (conversationId, session) =>
			services.conversations.recordRunEnd(conversationId, session),
	});

	const services: Services = {
		modelRuntime: runtime,
		credentials,
		models,
		events,
		hub,
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
