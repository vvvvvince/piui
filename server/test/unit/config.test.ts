import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/config.js";

const base = { PIUI_HOME: "/tmp/piui-config-test" };

describe("config", () => {
	it("defaults to loopback, port 8787 and ~/.piui-derived paths", () => {
		const { config } = parseConfig(base);
		expect(config.host).toBe("127.0.0.1");
		expect(config.port).toBe(8787);
		expect(config.dbPath).toBe(join("/tmp/piui-config-test", "piui.db"));
		expect(config.sessionsDir).toBe(join("/tmp/piui-config-test", "agent", "sessions"));
	});

	it("refuses to bind 0.0.0.0 without PIUI_ALLOW_REMOTE", () => {
		expect(() => parseConfig({ ...base, PIUI_HOST: "0.0.0.0" })).toThrow(ConfigError);
	});

	it("binds 0.0.0.0 with PIUI_ALLOW_REMOTE=1 and warns loudly", () => {
		const { config, warnings } = parseConfig({
			...base,
			PIUI_HOST: "0.0.0.0",
			PIUI_ALLOW_REMOTE: "1",
		});
		expect(config.host).toBe("0.0.0.0");
		expect(warnings.find((w) => w.message.includes("reachable from the network"))?.level).toBe(
			"warn",
		);
	});

	it("downgrades the remote-bind warning to info inside a container", () => {
		const { warnings } = parseConfig({
			...base,
			PIUI_HOST: "0.0.0.0",
			PIUI_ALLOW_REMOTE: "1",
			PIUI_CONTAINER: "1",
		});
		const remote = warnings.find((w) => w.message.includes("container"));
		expect(remote?.level).toBe("info");
		expect(warnings.some((w) => w.message.includes("reachable from the network"))).toBe(false);
	});

	it("warns when PIUI_SESSION_SECRET is unset and when default credentials are in use", () => {
		const { warnings } = parseConfig(base);
		expect(warnings.some((w) => w.message.includes("PIUI_SESSION_SECRET"))).toBe(true);
		expect(warnings.some((w) => w.message.includes("default test/test credentials"))).toBe(true);
	});

	it("does not warn about credentials when they are overridden", () => {
		const { config, warnings } = parseConfig({ ...base, PIUI_USERNAME: "a", PIUI_PASSWORD: "b" });
		expect(config.defaultCredentials).toBe(false);
		expect(warnings.some((w) => w.message.includes("credentials"))).toBe(false);
	});

	it("parses the workspace-root allowlist and rejects a bad search provider", () => {
		const { config } = parseConfig({
			...base,
			PIUI_WORKSPACE_ROOTS: "/srv/code:/home/me/projects",
		});
		expect(config.workspaceRoots).toEqual(["/srv/code", "/home/me/projects"]);
		expect(() => parseConfig({ ...base, PIUI_SEARCH_PROVIDER: "google" })).toThrow(ConfigError);
	});

	it("freezes the parsed config", () => {
		const { config } = parseConfig(base);
		expect(Object.isFrozen(config)).toBe(true);
	});
});
