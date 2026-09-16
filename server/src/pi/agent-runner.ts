// The only place that constructs a pi AgentSession. spec/01-architecture.md §4.1-4.2,
// spikes plan/spikes/03 (noTools: "all") and 05 (always pass a sessionDir).
import {
	type AgentSession,
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionMode, ThinkingLevel } from "@piui/shared";
import type { PiuiPromptTemplate } from "./prompts.js";
import { createResourceLoader, createSettingsManager } from "./resources.js";
import type { ModelRuntime } from "./runtime.js";

export interface ResolvedSessionConfig {
	conversationId: string;
	mode: SessionMode;
	/** The pi `Model` resolved by ModelService. */
	model: unknown;
	thinkingLevel: ThinkingLevel;
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	/** Chat mode only — agent mode keeps pi's default prompt (spec/03-profiles.md §2). */
	systemPrompt?: string;
	/** Resolved built-in tool allowlist; empty in chat mode. */
	tools: string[];
	customTools?: unknown[];
	agentsFiles?: { path: string; content: string }[];
	/** Resolved pi `Skill` objects; agent mode only (spec/03-profiles.md §3). */
	skills?: unknown[];
	/** Composed prompt templates, highest precedence first (spec/15 §3.1). */
	prompts?: PiuiPromptTemplate[];
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
}

export interface SessionManagerLike {
	/** Opaque pi SessionManager. */
	readonly __brand?: never;
}

export interface CreateSessionInput {
	config: ResolvedSessionConfig;
	sessionManager: unknown;
}

export interface AgentRunnerHandle {
	session: AgentSession;
	dispose(): void;
}

export interface OpenSessionManagerInput {
	cwd: string;
	sessionsDir: string;
	/** Existing pi session file to revive; omit for a new conversation. */
	path?: string | null;
}

/** Never call `SessionManager.create(cwd)` without a sessionDir — it writes to the real ~/.pi. */
export function openSessionManager(input: OpenSessionManagerInput): unknown {
	if (input.path) {
		try {
			return SessionManager.open(input.path, input.sessionsDir, input.cwd);
		} catch {
			// The session file was deleted/corrupted: start a fresh one rather than 500.
		}
	}
	return SessionManager.create(input.cwd, input.sessionsDir);
}

export async function createSession(input: CreateSessionInput): Promise<AgentRunnerHandle> {
	const { config } = input;
	const settingsManager = createSettingsManager({
		...(config.steeringMode ? { steeringMode: config.steeringMode } : {}),
		...(config.followUpMode ? { followUpMode: config.followUpMode } : {}),
	});
	const resourceLoader = await createResourceLoader({
		cwd: config.cwd,
		agentDir: config.agentDir,
		settingsManager,
		...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
		...(config.agentsFiles ? { agentsFiles: config.agentsFiles } : {}),
		...(config.skills ? { skills: config.skills } : {}),
		...(config.prompts ? { prompts: config.prompts } : {}),
	});

	const { session } = await createAgentSession({
		cwd: config.cwd,
		agentDir: config.agentDir,
		modelRuntime: config.modelRuntime,
		model: config.model as never,
		thinkingLevel: config.thinkingLevel === "off" ? "minimal" : config.thinkingLevel,
		// `tools: []` means "pi defaults" — chat mode must say noTools explicitly (spike S3).
		...(config.tools.length > 0 ? { tools: config.tools } : { noTools: "all" as const }),
		...(config.customTools ? { customTools: config.customTools as never } : {}),
		resourceLoader,
		sessionManager: input.sessionManager as never,
		settingsManager,
	});

	return {
		session,
		dispose() {
			session.dispose();
		},
	};
}
