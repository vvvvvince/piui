// Per-conversation ResourceLoader + the chat system prompt.
// spec/01-architecture.md §4.3 (spike plan/spikes/02), spec/07-chat-mode.md §2.
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ChatPromptInput {
	webSearch: boolean;
	/** ISO date, e.g. "2026-02-20". */
	date: string;
	timezone: string;
}

const WEB_SEARCH_ON = `- You can call \`web_search\` to find pages and \`web_fetch\` to read one. Search when the question
  concerns current events, versions, prices, docs, or anything you might have stale knowledge
  about. Prefer one or two focused searches over many. Always cite the sources you used as
  Markdown links at the end under a "Sources" heading.`;

const WEB_SEARCH_OFF = `- You have no web access in this conversation. If a question requires current information, say
  that the user can enable web search with the toggle in the composer.`;

/** The fixed chat prompt of spec/07-chat-mode.md §2. No persona, by decision Q6. */
export function buildChatSystemPrompt(input: ChatPromptInput): string {
	return `You are a helpful assistant answering questions in a web chat interface.

- Answer directly and concisely. Expand only when the question needs it.
- Use Markdown: fenced code blocks with a language, tables when comparing, short lists.
- Render math as LaTeX in $…$ / $$…$$.
- If you are unsure or the answer depends on recent information, say so.
${input.webSearch ? WEB_SEARCH_ON : WEB_SEARCH_OFF}
- You have no access to the user's files, terminal, or any persistent memory. Do not claim
  otherwise and do not offer to modify files.
- Today's date is ${input.date}. The user's timezone is ${input.timezone}.
`;
}

/**
 * Chat mode's tool allowlist (spec/05-skills-and-tools.md §B.4): never a built-in, and the
 * two web tools only when the toggle is on. The availability policy (is a provider
 * configured? has an admin disabled the tool?) lives in `tools/registry.ts` and is passed in
 * as `available`, so this function stays the single place that can *add* a tool to a chat.
 */
export function resolveChatTools(input: { webSearch: boolean; available?: string[] }): string[] {
	if (!input.webSearch) return [];
	const available = input.available ?? ["web_search", "web_fetch"];
	return ["web_search", "web_fetch"].filter((name) => available.includes(name));
}

export interface ResourceLoaderInput {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	systemPrompt: string;
	/** Agent mode only; chat mode contributes none of these (spec/07-chat-mode.md §1). */
	agentsFiles?: { path: string; content: string }[];
	skills?: unknown[];
}

/**
 * A loader with every ambient source suppressed: no host extension, no ambient skill, no
 * project `.pi/settings.json`, no context file. Verified by an integration test.
 */
export async function createResourceLoader(
	input: ResourceLoaderInput,
): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: input.settingsManager,
		additionalExtensionPaths: [],
		extensionFactories: [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => input.systemPrompt,
		skillsOverride: () => ({ skills: (input.skills ?? []) as never[], diagnostics: [] }),
		promptsOverride: (base) => ({ prompts: [], diagnostics: base.diagnostics }),
		agentsFilesOverride: () => ({ agentsFiles: input.agentsFiles ?? [] }),
	});
	await loader.reload();
	return loader;
}

/** piui owns its settings; the user's global pi settings are never mutated. */
export function createSettingsManager(overrides: {
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
}): SettingsManager {
	return SettingsManager.inMemory({
		enableSkillCommands: true,
		enableInstallTelemetry: false,
		steeringMode: overrides.steeringMode ?? "all",
		followUpMode: overrides.followUpMode ?? "one-at-a-time",
	} as never);
}
