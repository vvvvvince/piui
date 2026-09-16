// spec/05-skills-and-tools.md §§B.1, B.4 — the catalog and the one resolution function.
import { describe, expect, it } from "vitest";
import { installedBuiltinToolNames } from "../../src/pi/builtin-tools.js";
import { BUILTIN_PI_TOOLS, ToolRegistry } from "../../src/tools/registry.js";
import { withTempHome } from "../support/temp-home.js";

const registryOf = async (
	fn: (registry: ToolRegistry) => void | Promise<void>,
	options: { configured?: boolean } = {},
) =>
	withTempHome(async (t) => {
		const registry = new ToolRegistry({
			repos: t.ctx.repos,
			search: {
				id: options.configured === false ? "none" : "brave",
				configured: options.configured !== false,
				search: async () => [],
			},
			logger: t.ctx.logger,
		});
		await fn(registry);
	});

describe("tool catalog", () => {
	it("[05-skills-and-tools#B.1] lists pi's built-ins with the specified danger flags", async () => {
		await registryOf((registry) => {
			const items = registry.list();
			const byName = new Map(items.map((item) => [item.name, item]));
			for (const name of ["read", "ls", "grep", "find", "edit", "write", "bash"]) {
				expect(byName.get(name), `${name} missing from the catalog`).toBeDefined();
				expect(byName.get(name)!.kind).toBe("builtin_pi");
			}
			expect(byName.get("bash")!.dangerous).toBe(true);
			expect(byName.get("write")!.dangerous).toBe(true);
			expect(byName.get("edit")!.dangerous).toBe(true);
			expect(byName.get("read")!.dangerous).toBe(false);
			expect(byName.get("grep")!.dangerous).toBe(false);
			// powershell is offered only on Windows hosts
			expect(byName.has("powershell")).toBe(process.platform === "win32");
		});
	});

	it("[05-skills-and-tools#B.1] validates the built-in names against the installed pi", () => {
		const installed = new Set(installedBuiltinToolNames());
		const missing = BUILTIN_PI_TOOLS.map((tool) => tool.name).filter(
			(name) => !installed.has(name),
		);
		expect(missing, "a built-in tool name disappeared upstream").toEqual([]);
	});

	it("[05-skills-and-tools#B.1] marks web_search/web_fetch available only with a provider", async () => {
		await registryOf((registry) => {
			const search = registry.list().find((item) => item.name === "web_search")!;
			expect(search.kind).toBe("builtin_piui");
			expect(search.enabled).toBe(true);
			expect(search.configurable).toBe(true);
		});
		await registryOf(
			(registry) => {
				const search = registry.list().find((item) => item.name === "web_search")!;
				expect(search.enabled, "no provider configured → not available").toBe(false);
			},
			{ configured: false },
		);
	});

	it("[05-skills-and-tools#B.1] hides memory_append from profile selection", async () => {
		await registryOf((registry) => {
			const memory = registry.list().find((item) => item.name === "memory_append")!;
			expect(memory.selectableInProfile).toBe(false);
		});
	});

	it("[05-skills-and-tools#B.5.4] a globally disabled tool stays in the catalog but out of resolution", async () => {
		await registryOf((registry) => {
			registry.setEnabled("bash", false);
			const bash = registry.list().find((item) => item.name === "bash")!;
			expect(bash.enabled).toBe(false);
			expect(registry.isEnabled("bash")).toBe(false);

			registry.setEnabled("web_search", false);
			expect(registry.resolveChat({ webSearch: true }).toolNames).toEqual([]);
			expect(registry.resolveChat({ webSearch: true }).warnings[0]).toMatch(/disabled/i);

			registry.setEnabled("web_search", true);
			expect(registry.resolveChat({ webSearch: true }).toolNames).toEqual([
				"web_search",
				"web_fetch",
			]);
		});
	});

	it("[05-skills-and-tools#B.4] chat mode resolves zero built-ins, whatever the toggle", async () => {
		await registryOf((registry) => {
			expect(registry.resolveChat({ webSearch: false }).toolNames).toEqual([]);
			const on = registry.resolveChat({ webSearch: true });
			expect(on.toolNames).toEqual(["web_search", "web_fetch"]);
			expect(on.toolNames.some((name) => BUILTIN_PI_TOOLS.some((t) => t.name === name))).toBe(
				false,
			);
		});
	});

	it("[05-skills-and-tools#B.4] refuses to resolve web tools when the provider is unconfigured", async () => {
		await registryOf(
			(registry) => {
				const resolved = registry.resolveChat({ webSearch: true });
				expect(resolved.toolNames).toEqual([]);
				expect(resolved.warnings[0]).toMatch(/not configured/i);
			},
			{ configured: false },
		);
	});

	it("[05-skills-and-tools#B.1] counts the profiles using each tool", async () => {
		await withTempHome(async (t) => {
			const registry = new ToolRegistry({
				repos: t.ctx.repos,
				search: { id: "brave", configured: true, search: async () => [] },
				logger: t.ctx.logger,
			});
			const principal = { id: "local", username: "local", roles: ["admin"] as string[] };
			const profile = t.ctx.repos.profiles.create(principal as never, { name: "coder" });
			t.ctx.repos.profiles.setTools(principal as never, profile.id, ["bash", "read"]);

			const byName = new Map(registry.list().map((item) => [item.name, item]));
			expect(byName.get("bash")!.usedByProfiles).toBe(1);
			expect(byName.get("write")!.usedByProfiles).toBe(0);
		});
	});
});
