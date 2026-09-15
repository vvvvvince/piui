// A real AgentSession wired to the scripted fake provider, with ambient discovery suppressed
// (spike plan/spikes/02). Test-only: production session construction lands in M2's
// server/src/pi/agent-runner.ts.
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AppContext } from "../../src/context.js";
import { createFakeRuntime, type FakeRuntime } from "./fake-model.js";
import { assertInTempRoot } from "./temp-root-guard.js";

export interface FakeSession extends FakeRuntime {
	session: AgentSession;
	events: AgentSessionEvent[];
	/** Text of every assistant text block, concatenated in order. */
	assistantText(): string;
	dispose(): void;
}

export interface FakeSessionOptions {
	cwd: string;
	tools?: string[];
	systemPrompt?: string;
	agentsFiles?: { path: string; content: string }[];
	retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
}

export async function createFakeSession(
	ctx: AppContext,
	options: FakeSessionOptions,
): Promise<FakeSession> {
	assertInTempRoot(options.cwd, "session cwd");
	assertInTempRoot(ctx.config.sessionsDir, "sessions dir");

	const runtime = await createFakeRuntime(ctx);
	const settingsManager = SettingsManager.inMemory({
		enableSkillCommands: true,
		...(options.retry ? { retry: options.retry } : {}),
	});

	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: ctx.config.agentDir,
		settingsManager,
		additionalExtensionPaths: [],
		extensionFactories: [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => options.systemPrompt ?? "You are piui's test agent.",
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: (base) => ({ prompts: [], diagnostics: base.diagnostics }),
		agentsFilesOverride: () => ({ agentsFiles: options.agentsFiles ?? [] }),
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: ctx.config.agentDir,
		modelRuntime: runtime.runtime,
		model: runtime.model,
		thinkingLevel: "medium",
		...(options.tools && options.tools.length > 0
			? { tools: options.tools }
			: { noTools: "all" as const }),
		resourceLoader: loader,
		// Always pass the sessions dir: SessionManager.create(cwd) alone writes to the real ~/.pi.
		sessionManager: SessionManager.create(options.cwd, ctx.config.sessionsDir),
		settingsManager,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));

	return {
		...runtime,
		session,
		events,
		assistantText() {
			return session.messages
				.filter((m: any) => m.role === "assistant")
				.flatMap((m: any) =>
					(m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text),
				)
				.join("");
		},
		dispose() {
			session.dispose();
		},
	};
}
