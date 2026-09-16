// The tool catalog and the one resolution function. spec/05-skills-and-tools.md §§B.1, B.4.
//
// Note the layering: this module never imports pi. The built-in *names* are data here and are
// checked against the installed pi by `validateAgainstPi()`, which the boot wiring feeds from
// `server/src/pi/builtin-tools.ts`.
import type { ToolCatalogItem, ToolDescriptor, ToolKind } from "@piui/shared";
import type { Repositories } from "../db/repositories/index.js";

export interface BuiltinToolSpec {
	name: string;
	label: string;
	description: string;
	dangerous: boolean;
	/** Offered only on Windows hosts (spec §B.1). */
	windowsOnly?: boolean;
	/** Not selectable in a profile editor (memory_append is implicit). */
	implicit?: boolean;
}

/** spec/05-skills-and-tools.md §B.1, table 1 — proxied straight to pi's built-in tools. */
export const BUILTIN_PI_TOOLS: readonly BuiltinToolSpec[] = [
	{
		name: "read",
		label: "Read file",
		description: "Read a file from the workspace.",
		dangerous: false,
	},
	{ name: "ls", label: "List directory", description: "List a directory.", dangerous: false },
	{
		name: "grep",
		label: "Search contents",
		description: "Search file contents.",
		dangerous: false,
	},
	{ name: "find", label: "Find files", description: "Find files by name.", dangerous: false },
	{ name: "edit", label: "Edit file", description: "Modify an existing file.", dangerous: true },
	{
		name: "write",
		label: "Write file",
		description: "Create or overwrite a file.",
		dangerous: true,
	},
	{
		name: "bash",
		label: "Run shell command",
		description: "Run a shell command.",
		dangerous: true,
	},
	{
		name: "powershell",
		label: "Run PowerShell",
		description: "Run a PowerShell command.",
		dangerous: true,
		windowsOnly: true,
	},
];

/** spec/05-skills-and-tools.md §B.1, table 2 — implemented by piui with `defineTool`. */
export const BUILTIN_PIUI_TOOLS: readonly (BuiltinToolSpec & { needsSearchProvider?: boolean })[] =
	[
		{
			name: "web_search",
			label: "Web search",
			description: "Search the web for current information.",
			dangerous: false,
			needsSearchProvider: true,
		},
		{
			name: "web_fetch",
			label: "Fetch web page",
			description: "Fetch one http(s) URL and read it as Markdown.",
			dangerous: false,
			needsSearchProvider: true,
		},
		{
			name: "memory_append",
			label: "Remember",
			description: "Append a durable note to the profile's memory file.",
			dangerous: false,
			implicit: true,
		},
	];

export interface RegistryLogger {
	error(obj: object, msg: string): void;
}

export interface SearchProviderStatus {
	readonly id: string;
	readonly configured: boolean;
}

/** The slice of the extension service the catalog needs (spec/16-extensions.md §4). */
export interface ExtensionToolSource {
	records(): {
		id: string;
		name: string;
		enabled: boolean;
		loadError: string | null;
		tools: string[];
	}[];
}

export interface ToolRegistryDeps {
	repos: Pick<Repositories, "tools">;
	/** Absent in unit tests that only care about built-ins. */
	extensions?: ExtensionToolSource;
	search: SearchProviderStatus;
	logger: RegistryLogger;
	/** Overridable for tests; production passes `process.platform`. */
	platform?: NodeJS.Platform;
}

export interface ResolvedTools {
	/** Names handed to pi as the allowlist — also the custom-tool names (spike plan/spikes/08). */
	toolNames: string[];
	warnings: string[];
}

/** spec/05-skills-and-tools.md §B.4 — the single input to tool resolution. */
export interface ResolveToolsInput {
	mode: "chat" | "agent";
	webSearch: boolean;
	profile?: { toolNames: readonly string[]; memoryEnabled: boolean };
	/**
	 * spec/16-extensions.md §4 — tools registered by the extensions this conversation loads.
	 * They are *not* per-profile selectable: the lever is the extension's disable switch (§3),
	 * which is what makes acceptance 10.3 ("active without any UI action") true.
	 */
	extensionToolNames?: readonly string[];
}

export interface ResolvedToolSet extends ResolvedTools {
	/** pi's own tools — the `tools` allowlist minus everything piui implements. */
	builtinToolNames: string[];
	/** piui `defineTool` definitions the session must also receive (spike plan/spikes/08). */
	customToolNames: string[];
	/** Names an extension registers; pi owns their implementation (spec/16 §4). */
	extensionToolNames: string[];
}

export class ToolRegistry {
	constructor(private readonly deps: ToolRegistryDeps) {}

	private get platform(): NodeJS.Platform {
		return this.deps.platform ?? process.platform;
	}

	/** §B.1: log an error if a built-in name disappeared from the installed pi. */
	validateAgainstPi(installedNames: readonly string[]): string[] {
		const installed = new Set(installedNames);
		const missing = BUILTIN_PI_TOOLS.filter((tool) => !tool.windowsOnly)
			.map((tool) => tool.name)
			.filter((name) => !installed.has(name));
		if (missing.length > 0) {
			this.deps.logger.error(
				{ missing, installed: [...installed] },
				"built-in pi tool names changed upstream — the catalog is stale",
			);
		}
		return missing;
	}

	list(): ToolCatalogItem[] {
		const disabled = this.deps.repos.tools.disabledNames();
		const usage = this.deps.repos.tools.profileUsage();
		const items: ToolCatalogItem[] = [];

		const push = (spec: BuiltinToolSpec, kind: ToolKind, available: boolean): void => {
			items.push({
				name: spec.name,
				label: spec.label,
				description: spec.description,
				kind,
				enabled: available && !disabled.has(spec.name),
				selectableInProfile: spec.implicit !== true,
				dangerous: spec.dangerous,
				configurable: kind === "builtin_piui" && spec.name !== "memory_append",
				usedByProfiles: usage.get(spec.name) ?? 0,
			});
		};

		for (const spec of BUILTIN_PI_TOOLS) {
			if (spec.windowsOnly && this.platform !== "win32") continue;
			push(spec, "builtin_pi", true);
		}
		for (const spec of BUILTIN_PIUI_TOOLS) {
			const available = spec.needsSearchProvider ? this.deps.search.configured : true;
			push(spec, "builtin_piui", available);
		}
		// spec/16-extensions.md §4 — extension-registered tools, cached by the probe. A name that
		// collides with a built-in is dropped here, so it can never shadow `bash`/`read`/….
		const builtinNames = new Set(items.map((item) => item.name));
		for (const extension of this.deps.extensions?.records() ?? []) {
			if (!extension.enabled || extension.loadError) continue;
			for (const name of extension.tools) {
				if (builtinNames.has(name)) continue;
				builtinNames.add(name);
				items.push({
					name,
					label: name,
					description: `Registered by the "${extension.name}" extension.`,
					kind: "extension",
					enabled: !disabled.has(name),
					// Per-profile control is the extension's disable switch, not a tool checkbox (§3).
					selectableInProfile: false,
					dangerous: false,
					configurable: false,
					usedByProfiles: usage.get(name) ?? 0,
				});
			}
		}
		return items;
	}

	get(name: string): ToolCatalogItem | undefined {
		return this.list().find((item) => item.name === name);
	}

	/** Known to the catalog at all (an unknown name is a 404, not a silent no-op). */
	knows(name: string): boolean {
		return this.list().some((item) => item.name === name);
	}

	isEnabled(name: string): boolean {
		return this.get(name)?.enabled === true;
	}

	setEnabled(name: string, enabled: boolean): ToolDescriptor {
		this.deps.repos.tools.setEnabled(name, enabled);
		return this.get(name)!;
	}

	get searchStatus(): { provider: string; configured: boolean } {
		return { provider: this.deps.search.id, configured: this.deps.search.configured };
	}

	/**
	 * spec/05-skills-and-tools.md §B.4, chat mode: built-ins are *always* empty; the web tools
	 * are added only when the toggle is on, the provider is configured, and neither tool has
	 * been globally disabled. Enforced here, not at the call site.
	 */
	/**
	 * The correctness centre (spec/05-skills-and-tools.md §B.4). Chat mode can never reach a
	 * filesystem tool, whatever a profile says — enforced *here*, not at the call site.
	 */
	resolveTools(input: ResolveToolsInput): ResolvedToolSet {
		if (input.mode === "chat") {
			const chat = this.resolveChat({ webSearch: input.webSearch });
			return {
				builtinToolNames: [],
				customToolNames: chat.toolNames,
				extensionToolNames: [],
				toolNames: chat.toolNames,
				warnings: chat.warnings,
			};
		}
		const resolved = this.resolveAgent(input.profile ?? { toolNames: [], memoryEnabled: false });
		for (const name of input.extensionToolNames ?? []) {
			if (resolved.toolNames.includes(name)) continue;
			if (!this.isEnabled(name)) continue;
			resolved.toolNames.push(name);
			resolved.extensionToolNames.push(name);
		}
		return resolved;
	}

	/** Agent mode: the profile's selection minus unknown/disabled names, plus memory_append. */
	private resolveAgent(profile: {
		toolNames: readonly string[];
		memoryEnabled: boolean;
	}): ResolvedToolSet {
		const warnings: string[] = [];
		const builtinToolNames: string[] = [];
		const customToolNames: string[] = [];
		const catalog = new Map(this.list().map((item) => [item.name, item]));

		for (const name of profile.toolNames) {
			const item = catalog.get(name);
			if (!item) {
				warnings.push(`Tool "${name}" no longer exists and was dropped from this profile.`);
				continue;
			}
			if (!item.enabled) {
				warnings.push(
					item.kind === "builtin_piui" && !this.deps.search.configured
						? `Tool "${name}" is not configured on this server and was dropped.`
						: `Tool "${name}" is disabled globally by an administrator and was dropped.`,
				);
				continue;
			}
			(item.kind === "builtin_pi" ? builtinToolNames : customToolNames).push(name);
		}
		// §4: memory_append is implied by memory.enabled, never individually selectable.
		if (profile.memoryEnabled && !customToolNames.includes("memory_append")) {
			customToolNames.push("memory_append");
		}
		return {
			builtinToolNames,
			customToolNames,
			extensionToolNames: [],
			toolNames: [...builtinToolNames, ...customToolNames],
			warnings,
		};
	}

	resolveChat(input: { webSearch: boolean }): ResolvedTools {
		if (!input.webSearch) return { toolNames: [], warnings: [] };
		const warnings: string[] = [];
		if (!this.deps.search.configured) {
			warnings.push(
				"Web search is on for this conversation, but the search provider is not configured on this server.",
			);
			return { toolNames: [], warnings };
		}
		const disabled = ["web_search", "web_fetch"].filter((name) => !this.isEnabled(name));
		if (disabled.length > 0) {
			warnings.push(`${disabled.join(" and ")} is disabled globally by an administrator.`);
			return { toolNames: [], warnings };
		}
		return { toolNames: ["web_search", "web_fetch"], warnings };
	}
}
