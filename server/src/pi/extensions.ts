// The pi boundary for extensions: the load probe (spec/16-extensions.md §4) and the RPC UI
// binding (§5). Spike plan/spikes/11.
import {
	type AgentSession,
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ProbeInput {
	paths: readonly string[];
	cwd: string;
	agentDir: string;
}

export interface ProbedExtension {
	path: string;
	tools: string[];
	commands: string[];
}

export interface ProbeResult {
	loaded: ProbedExtension[];
	/** One entry per path pi refused; the reload itself never throws (spike §1). */
	errors: { path: string; error: string }[];
}

/**
 * A loader reload is enough to enumerate an extension's tools and commands: no session, no
 * model call, and a broken file can never reach a conversation from here.
 */
export async function probeExtensions(input: ProbeInput): Promise<ProbeResult> {
	if (input.paths.length === 0) return { loaded: [], errors: [] };
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: SettingsManager.inMemory({} as never),
		additionalExtensionPaths: [...input.paths],
		extensionFactories: [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	try {
		await loader.reload();
	} catch (error) {
		// Defensive: 0.85.1 does not throw here, but a probe must never take the caller down.
		return { loaded: [], errors: input.paths.map((path) => ({ path, error: String(error) })) };
	}
	const result = loader.getExtensions();
	return {
		loaded: result.extensions.map((extension) => ({
			path: extension.path,
			tools: [...extension.tools.keys()],
			commands: [...extension.commands.keys()],
		})),
		errors: result.errors.map((error) => ({ path: error.path, error: error.error })),
	};
}

/** The piui side of pi's `ExtensionUIContext` — structural, so the hub never imports pi. */
export interface PiuiExtensionUiPort {
	ask(request: {
		method: "select" | "confirm" | "input" | "editor";
		title?: string;
		message?: string;
		options?: string[];
		placeholder?: string;
		prefill?: string;
		timeoutMs?: number;
	}): Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }>;
	notify(message: string, level: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | null): void;
	setWidget(key: string, lines: string[] | null, placement: "aboveEditor" | "belowEditor"): void;
	setEditorText(text: string): void;
	onError(error: { extensionPath: string; error: string }): void;
}

/**
 * spec/16-extensions.md §5 — `mode: "rpc"`: dialogs work, TUI-only members degrade to no-ops
 * with pi's documented return values.
 */
export async function bindExtensionUi(session: AgentSession, port: PiuiExtensionUiPort) {
	const dialog = async (
		method: "select" | "confirm" | "input" | "editor",
		fields: Record<string, unknown>,
		opts?: { timeout?: number },
	) =>
		port.ask({
			method,
			...fields,
			...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
		} as Parameters<PiuiExtensionUiPort["ask"]>[0]);

	const uiContext = {
		select: async (title: string, options: string[], opts?: { timeout?: number }) =>
			(await dialog("select", { title, options }, opts)).value,
		confirm: async (title: string, message: string, opts?: { timeout?: number }) =>
			(await dialog("confirm", { title, message }, opts)).confirmed === true,
		input: async (title: string, placeholder?: string, opts?: { timeout?: number }) =>
			(await dialog("input", { title, ...(placeholder ? { placeholder } : {}) }, opts)).value,
		editor: async (title: string, prefill?: string) =>
			(await dialog("editor", { title, ...(prefill ? { prefill } : {}) })).value,
		notify: (message: string, type?: "info" | "warning" | "error") =>
			port.notify(message, type ?? "info"),
		setStatus: (key: string, text: string | undefined) => port.setStatus(key, text ?? null),
		setWidget: (key: string, content: unknown, options?: { placement?: string }) =>
			port.setWidget(
				key,
				Array.isArray(content) ? (content as string[]) : null,
				options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
			),
		setEditorText: (text: string) => port.setEditorText(text),
		pasteToEditor: (text: string) => port.setEditorText(text),
		getEditorText: () => "",
		// TUI-only members: documented degraded behavior, mirroring pi's RPC table.
		setTitle: () => {},
		onTerminalInput: () => () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setFooter: () => {},
		setHeader: () => {},
		custom: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "themes are not available in piui" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	await session.bindExtensions({
		mode: "rpc",
		uiContext: uiContext as never,
		onError: (error) => port.onError({ extensionPath: error.extensionPath, error: error.error }),
	});
	// Spike §5: names registered during `session_start` are only visible now.
	return session.extensionRunner
		.getAllRegisteredTools()
		.map((tool) => (tool as { definition?: { name?: string } }).definition?.name)
		.filter((name): name is string => typeof name === "string");
}
