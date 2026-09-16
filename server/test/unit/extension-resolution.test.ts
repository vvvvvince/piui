// spec/16-extensions.md §3 — resolution is one array filter: globally enabled, minus the
// profile's disabled set, minus load-failed, deterministically ordered.
import { describe, expect, it } from "vitest";
import { type ExtensionRecord, resolveExtensions } from "../../src/extensions/resolve.js";

const ext = (over: Partial<ExtensionRecord> & { name: string }): ExtensionRecord => ({
	id: over.name,
	path: `/home/piui/extensions/${over.name}.ts`,
	source: "managed",
	enabled: true,
	loadError: null,
	tools: [],
	commands: [],
	...over,
});

describe("resolveExtensions", () => {
	it("[16-extensions#10.4] drops only the profile's disabled ids, keeping the rest", () => {
		const all = [ext({ name: "alpha" }), ext({ name: "beta" })];
		expect(resolveExtensions({ all, disabledIds: ["beta"] }).paths).toEqual([
			"/home/piui/extensions/alpha.ts",
		]);
		expect(resolveExtensions({ all, disabledIds: [] }).paths).toEqual([
			"/home/piui/extensions/alpha.ts",
			"/home/piui/extensions/beta.ts",
		]);
	});

	it("[16-extensions#10.5] excludes globally disabled extensions and their tools", () => {
		const all = [ext({ name: "alpha", tools: ["deploy"], enabled: false })];
		const resolved = resolveExtensions({ all, disabledIds: [] });
		expect(resolved.paths).toEqual([]);
		expect(resolved.toolNames).toEqual([]);
	});

	it("orders managed before external, then alphabetically", () => {
		const all = [
			ext({ name: "zulu" }),
			ext({ name: "alpha", source: "external", path: "/user/.pi/agent/extensions/alpha.ts" }),
			ext({ name: "mike" }),
		];
		expect(resolveExtensions({ all, disabledIds: [] }).paths).toEqual([
			"/home/piui/extensions/mike.ts",
			"/home/piui/extensions/zulu.ts",
			"/user/.pi/agent/extensions/alpha.ts",
		]);
	});

	it("excludes a load-failed extension and warns, naming it", () => {
		const all = [ext({ name: "broken", loadError: "ParseError: Unexpected keyword" })];
		const resolved = resolveExtensions({ all, disabledIds: [] });
		expect(resolved.paths).toEqual([]);
		expect(resolved.warnings.join(" ")).toMatch(/broken.*ParseError/);
	});

	it("drops an extension tool that collides with a built-in, naming both sides", () => {
		const all = [ext({ name: "shady", tools: ["bash", "deploy"] })];
		const resolved = resolveExtensions({ all, disabledIds: [], builtinNames: ["bash", "read"] });
		expect(resolved.toolNames).toEqual(["deploy"]);
		expect(resolved.warnings.join(" ")).toMatch(/bash.*shady/);
		// the extension itself still loads: only the colliding tool name is dropped
		expect(resolved.paths).toEqual(["/home/piui/extensions/shady.ts"]);
	});
});
