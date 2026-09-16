// spec/05-skills-and-tools.md §B.4 — the one function that decides what a conversation can do.
// Chat mode yielding zero filesystem tools is the flagship assertion.
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { withTempHome } from "../support/temp-home.js";

const FS_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

async function withRegistry(
	options: { searchConfigured?: boolean; disabled?: string[] },
	fn: (tools: ToolRegistry) => void,
): Promise<void> {
	await withTempHome(async ({ ctx }) => {
		for (const name of options.disabled ?? []) ctx.repos.tools.setEnabled(name, false);
		fn(
			new ToolRegistry({
				repos: ctx.repos,
				search: { id: "searxng", configured: options.searchConfigured !== false },
				logger: { error: () => {} },
				platform: "linux",
			}),
		);
	});
}

describe("resolveTools", () => {
	it("[05-skills-and-tools#B.4] chat mode yields zero filesystem tools, whatever the profile says", async () => {
		await withRegistry({}, (tools) => {
			for (const webSearch of [true, false]) {
				const resolved = tools.resolveTools({
					mode: "chat",
					webSearch,
					profile: { toolNames: FS_TOOLS, memoryEnabled: true },
				});
				expect(resolved.builtinToolNames).toEqual([]);
				expect(resolved.customToolNames).toEqual(webSearch ? ["web_search", "web_fetch"] : []);
				expect(resolved.toolNames.some((name) => FS_TOOLS.includes(name))).toBe(false);
				expect(resolved.toolNames).not.toContain("memory_append");
			}
		});
	});

	it("[05-skills-and-tools#B.4] agent mode passes the profile's selection through, split by kind", async () => {
		await withRegistry({}, (tools) => {
			const resolved = tools.resolveTools({
				mode: "agent",
				webSearch: false,
				profile: { toolNames: ["read", "ls", "web_search"], memoryEnabled: false },
			});
			expect(resolved.builtinToolNames).toEqual(["read", "ls"]);
			expect(resolved.customToolNames).toEqual(["web_search"]);
			expect(resolved.toolNames).toEqual(["read", "ls", "web_search"]);
			expect(resolved.warnings).toEqual([]);
		});
	});

	it("[05-skills-and-tools#B.4] adds memory_append if and only if the profile enables memory", async () => {
		await withRegistry({}, (tools) => {
			const off = tools.resolveTools({
				mode: "agent",
				webSearch: false,
				profile: { toolNames: ["read"], memoryEnabled: false },
			});
			expect(off.toolNames).not.toContain("memory_append");
			const on = tools.resolveTools({
				mode: "agent",
				webSearch: false,
				profile: { toolNames: ["read"], memoryEnabled: true },
			});
			expect(on.customToolNames).toContain("memory_append");
			expect(on.toolNames).toEqual(["read", "memory_append"]);
		});
	});

	it("[05-skills-and-tools#B.4] drops unknown and globally disabled names with a warning", async () => {
		await withRegistry({ disabled: ["bash"] }, (tools) => {
			const resolved = tools.resolveTools({
				mode: "agent",
				webSearch: false,
				profile: { toolNames: ["read", "bash", "teleport"], memoryEnabled: false },
			});
			expect(resolved.toolNames).toEqual(["read"]);
			expect(resolved.warnings.join(" ")).toMatch(/bash/);
			expect(resolved.warnings.join(" ")).toMatch(/teleport/);
		});
	});

	it("[05-skills-and-tools#B.4] warns when a selected web tool has no configured provider", async () => {
		await withRegistry({ searchConfigured: false }, (tools) => {
			const resolved = tools.resolveTools({
				mode: "agent",
				webSearch: false,
				profile: { toolNames: ["read", "web_search"], memoryEnabled: false },
			});
			expect(resolved.toolNames).toEqual(["read"]);
			expect(resolved.warnings.join(" ")).toMatch(/not configured/i);
		});
	});

	it("[05-skills-and-tools#B.4] an empty profile selection resolves to no tools at all", async () => {
		await withRegistry({}, (tools) => {
			const resolved = tools.resolveTools({
				mode: "agent",
				webSearch: false,
				profile: { toolNames: [], memoryEnabled: false },
			});
			expect(resolved.toolNames).toEqual([]);
		});
	});
});
