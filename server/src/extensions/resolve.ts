// spec/16-extensions.md §3 — pure resolution. One array filter, no pi, no filesystem.
export interface ExtensionRecord {
	id: string;
	name: string;
	path: string;
	source: "managed" | "external";
	enabled: boolean;
	loadError: string | null;
	tools: string[];
	commands: string[];
}

export interface ResolveExtensionsInput {
	all: readonly ExtensionRecord[];
	/** The profile's opt-out list; empty for chat mode (spec §2). */
	disabledIds: readonly string[];
	/** Built-in / custom tool names an extension tool may never shadow (spec §4). */
	builtinNames?: readonly string[];
}

export interface ResolvedExtensions {
	/** `additionalExtensionPaths`, deterministically ordered. */
	paths: string[];
	toolNames: string[];
	commandNames: string[];
	warnings: string[];
}

export function resolveExtensions(input: ResolveExtensionsInput): ResolvedExtensions {
	const disabled = new Set(input.disabledIds);
	const builtins = new Set(input.builtinNames ?? []);
	const warnings: string[] = [];
	const paths: string[] = [];
	const toolNames: string[] = [];
	const commandNames: string[] = [];
	const seenTools = new Set<string>();

	const ordered = [...input.all].sort(
		(a, b) =>
			(a.source === b.source ? 0 : a.source === "managed" ? -1 : 1) || a.name.localeCompare(b.name),
	);
	for (const extension of ordered) {
		if (!extension.enabled || disabled.has(extension.id)) continue;
		if (extension.loadError) {
			warnings.push(
				`Extension "${extension.name}" failed to load and was skipped: ${extension.loadError}`,
			);
			continue;
		}
		paths.push(extension.path);
		for (const tool of extension.tools) {
			if (builtins.has(tool) || seenTools.has(tool)) {
				warnings.push(
					`Tool "${tool}" registered by extension "${extension.name}" collides with an existing tool of the same name and was dropped.`,
				);
				continue;
			}
			seenTools.add(tool);
			toolNames.push(tool);
		}
		commandNames.push(...extension.commands);
	}
	return { paths, toolNames, commandNames, warnings };
}
