// The ONLY module allowed to read process.env (enforced by a grep test).
// spec/01-architecture.md §3.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type SearchProviderId = "brave" | "tavily" | "searxng" | "none";

export interface Config {
	readonly home: string;
	readonly port: number;
	readonly host: string;
	readonly container: boolean;
	readonly insecureTransportOk: boolean;
	readonly allowRemote: boolean;
	readonly sessionSecret: string;
	readonly sessionSecretProvided: boolean;
	readonly agentDir: string;
	/**
	 * The *user's* pi agent dir (`~/.pi/agent`), read-only: its `prompts/` and `skills/` are
	 * discovered like the TUI does (spec/15-commands-and-input.md §3). `PIUI_USER_AGENT_DIR`
	 * redirects it, which is how tests avoid the real home.
	 */
	readonly userAgentDir: string;
	readonly sessionsDir: string;
	readonly piAuthPath: string;
	readonly disableCredentialWrites: boolean;
	readonly disableExtensionInstall: boolean;
	readonly workspaceRoots: readonly string[];
	readonly searchProvider: SearchProviderId;
	readonly searchApiKey: string | undefined;
	readonly searxngUrl: string | undefined;
	/** PIUI_ALLOW_PRIVATE_HTTP_TOOLS=1 disarms the SSRF guard (spec/05-skills-and-tools.md §B.2). */
	readonly allowPrivateHttpTools: boolean;
	readonly maxUploadMb: number;
	readonly maxConcurrentRuns: number;
	readonly maxRunMinutes: number;
	/** spec/08-agent-mode.md §6 — the second runaway guard: tool calls in one run. */
	readonly maxToolCallsPerRun: number;
	readonly username: string;
	readonly password: string;
	readonly defaultCredentials: boolean;
	readonly forceSecureCookie: boolean;
	readonly fakeModel: boolean;
	/** Dev-only: a JSON file of scripted fake-provider turns (PIUI_FAKE_MODEL=1 only). */
	readonly fakeScriptPath: string | undefined;
	readonly nodeEnv: string;
	readonly logLevel: string;
	readonly clientDist: string;
	readonly dbPath: string;
	/**
	 * The `${ENV_VAR}` reader for HTTP-tool headers (spec/05-skills-and-tools.md §B.2). It lives
	 * here because config.ts is the only module allowed to touch `process.env`, and the value is
	 * resolved at call time — never stored, never returned.
	 */
	readonly readEnv: (name: string) => string | undefined;
	readonly paths: {
		readonly profiles: string;
		readonly skills: string;
		readonly extensions: string;
		readonly prompts: string;
		readonly uploads: string;
		readonly scratch: string;
		readonly trash: string;
		readonly logs: string;
	};
}

export class ConfigError extends Error {}

export interface ConfigWarning {
	level: "warn" | "info";
	message: string;
}

export interface ParsedConfig {
	config: Config;
	warnings: ConfigWarning[];
}

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined): boolean => v === "1" || v === "true" || v === "yes";

function num(env: Env, key: string, fallback: number): number {
	const raw = env[key];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new ConfigError(`${key} must be a positive number, got ${JSON.stringify(raw)}`);
	}
	return parsed;
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function parseConfig(env: Env = process.env): ParsedConfig {
	const warnings: ConfigWarning[] = [];

	const home = resolve(expandHome(env.PIUI_HOME ?? join(homedir(), ".piui")));
	const host = env.PIUI_HOST ?? "127.0.0.1";
	const container = truthy(env.PIUI_CONTAINER);
	const allowRemote = truthy(env.PIUI_ALLOW_REMOTE);

	const isRemoteBind = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
	if (isRemoteBind && !allowRemote) {
		throw new ConfigError(
			`refusing to bind ${host}: set PIUI_ALLOW_REMOTE=1 to accept connections from the network ` +
				"(put TLS in front of piui before you do)",
		);
	}
	if (isRemoteBind) {
		warnings.push(
			container
				? {
						level: "info",
						message: `binding ${host} inside a container (network namespace is the boundary)`,
					}
				: {
						level: "warn",
						message: `piui is reachable from the network on ${host} — put a TLS reverse proxy in front of it`,
					},
		);
	}

	const sessionSecretProvided = Boolean(env.PIUI_SESSION_SECRET);
	if (!sessionSecretProvided) {
		warnings.push({
			level: "warn",
			message:
				"PIUI_SESSION_SECRET is unset: a random secret is generated per boot, so logins do not survive a restart",
		});
	}

	const username = env.PIUI_USERNAME ?? "test";
	const password = env.PIUI_PASSWORD ?? "test";
	const defaultCredentials = username === "test" && password === "test";
	if (defaultCredentials) {
		warnings.push({
			level: "warn",
			message: "!! piui is using the default test/test credentials !!",
		});
	}

	const workspaceRoots = (env.PIUI_WORKSPACE_ROOTS ?? "")
		.split(":")
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => resolve(expandHome(p)));
	for (const root of workspaceRoots) {
		if (!isAbsolute(root))
			throw new ConfigError(`PIUI_WORKSPACE_ROOTS entries must be absolute: ${root}`);
	}

	const searchProviderRaw = (env.PIUI_SEARCH_PROVIDER ?? "brave") as SearchProviderId;
	if (!["brave", "tavily", "searxng", "none"].includes(searchProviderRaw)) {
		throw new ConfigError(
			`PIUI_SEARCH_PROVIDER must be brave|tavily|searxng|none, got ${searchProviderRaw}`,
		);
	}

	const agentDir = resolve(expandHome(env.PIUI_AGENT_DIR ?? join(home, "agent")));

	const config: Config = Object.freeze({
		home,
		port: num(env, "PIUI_PORT", 8787),
		host,
		container,
		insecureTransportOk: truthy(env.PIUI_INSECURE_TRANSPORT_OK),
		allowRemote,
		sessionSecret: env.PIUI_SESSION_SECRET ?? randomSecret(),
		sessionSecretProvided,
		agentDir,
		userAgentDir: resolve(expandHome(env.PIUI_USER_AGENT_DIR ?? join(homedir(), ".pi", "agent"))),
		sessionsDir: join(agentDir, "sessions"),
		piAuthPath: resolve(
			expandHome(env.PIUI_PI_AUTH_PATH ?? join(homedir(), ".pi", "agent", "auth.json")),
		),
		disableCredentialWrites: truthy(env.PIUI_DISABLE_CREDENTIAL_WRITES),
		disableExtensionInstall: truthy(env.PIUI_DISABLE_EXTENSION_INSTALL),
		workspaceRoots: Object.freeze(workspaceRoots),
		searchProvider: searchProviderRaw,
		searchApiKey: env.PIUI_SEARCH_API_KEY || undefined,
		searxngUrl: env.PIUI_SEARXNG_URL || undefined,
		allowPrivateHttpTools: truthy(env.PIUI_ALLOW_PRIVATE_HTTP_TOOLS),
		maxUploadMb: num(env, "PIUI_MAX_UPLOAD_MB", 10),
		maxConcurrentRuns: num(env, "PIUI_MAX_CONCURRENT_RUNS", 4),
		maxRunMinutes: num(env, "PIUI_MAX_RUN_MINUTES", 30),
		maxToolCallsPerRun: num(env, "PIUI_MAX_TOOL_CALLS", 200),
		username,
		password,
		defaultCredentials,
		forceSecureCookie: truthy(env.PIUI_FORCE_SECURE_COOKIE),
		fakeModel: truthy(env.PIUI_FAKE_MODEL),
		fakeScriptPath: env.PIUI_FAKE_SCRIPT ? resolve(expandHome(env.PIUI_FAKE_SCRIPT)) : undefined,
		nodeEnv: env.NODE_ENV ?? "development",
		logLevel: env.PIUI_LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
		clientDist: resolve(env.PIUI_CLIENT_DIST ?? join(process.cwd(), "client", "dist")),
		dbPath: join(home, "piui.db"),
		readEnv: (name: string) => env[name],
		paths: Object.freeze({
			profiles: join(home, "profiles"),
			skills: join(home, "skills"),
			extensions: join(home, "extensions"),
			prompts: join(home, "prompts"),
			uploads: join(home, "uploads"),
			scratch: join(home, "scratch"),
			trash: join(home, "trash"),
			logs: join(home, "logs"),
		}),
	});

	return { config, warnings };
}

function randomSecret(): string {
	return randomBytes(32).toString("hex");
}
