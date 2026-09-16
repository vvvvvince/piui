// CredentialService — pi's credential surface plus the AuthFlow state machine.
// spec/14-credentials.md §§1-2, verified in plan/spikes/06-credentials-and-auth-flow.md.
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
	AuthFlowView,
	CredentialSource,
	ProviderAuthMethod,
	ProviderStatus,
	UiAuthEvent,
	UiAuthPrompt,
	VerifyProviderResponse,
} from "@piui/shared";
import { ApiError } from "../http/errors.js";
import type { IdGen } from "../util/clock.js";
import type { ModelRuntime } from "./runtime.js";

export const FLOW_TTL_MS = 5 * 60 * 1000;
export const FLOW_RETENTION_MS = 60 * 1000;
export const MAX_FLOWS_PER_PROVIDER = 3;
export const MAX_FLOWS = 10;
const REFRESH_DEADLINE_MS = 15_000;

/** Anything key-shaped is scrubbed before a provider message reaches a log or a client. */
const KEY_SHAPED = /\b(sk|pat|ghp|xoxb|gsk|api)[-_][A-Za-z0-9_-]{8,}/g;

export function sanitizeMessage(message: string, secrets: readonly string[] = []): string {
	let out = message;
	for (const secret of secrets) {
		if (secret.length < 4) continue;
		while (out.includes(secret)) out = out.replace(secret, "***");
	}
	return out.replace(KEY_SHAPED, "***");
}

interface PendingPrompt {
	id: string;
	prompt: UiAuthPrompt;
	resolve(value: string): void;
	reject(error: Error): void;
}

interface Flow {
	flowId: string;
	providerId: string;
	state: "prompting" | "working" | "done" | "error" | "cancelled";
	events: UiAuthEvent[];
	version: number;
	pending?: PendingPrompt;
	status?: ProviderStatus;
	warning?: string;
	message?: string;
	abort: AbortController;
	cancelling: boolean;
	lastActivity: number;
	terminalAt?: number;
	/** Values the user handed us; redacted out of any message we emit. */
	secrets: string[];
	/** Unconsumed prefills: the first `secret` prompt is auto-answered from `apiKey`. */
	prefill: { apiKey?: string; env: Record<string, string> };
	waiters: (() => void)[];
}

export interface CredentialLogger {
	info(obj: object, msg: string): void;
	warn(obj: object, msg: string): void;
	error(obj: object, msg: string): void;
}

export interface CredentialServiceDeps {
	runtime: ModelRuntime;
	authPath: string;
	ids: IdGen;
	nowMs(): number;
	logger: CredentialLogger;
	/** Invalidate the model cache, bump `credentialsRevision`, emit `providers_changed`. */
	onMutation(): void;
}

export class CredentialService {
	private readonly flows = new Map<string, Flow>();
	/**
	 * How long `start`/`respond` wait for the flow to leave "working" before answering with a
	 * `working` view the client long-polls. pi serializes credential operations per provider, so
	 * a second concurrent flow on the same provider genuinely sits here until the first finishes.
	 */
	settleBudgetMs = 10_000;

	constructor(private readonly deps: CredentialServiceDeps) {}

	// ------------------------------------------------------------- statuses

	async listProviders(): Promise<ProviderStatus[]> {
		const stored = await this.storedCredentialTypes();
		const available = this.deps.runtime.getAvailableSnapshot();
		const counts = new Map<string, number>();
		for (const model of available) {
			counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
		}
		return this.deps.runtime
			.getProviders()
			.map((provider) => this.statusOf(provider.id, stored, counts.get(provider.id) ?? 0))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** One provider, with a live availability probe (used after a mutation and by verify). */
	async providerStatus(providerId: string): Promise<ProviderStatus> {
		const stored = await this.storedCredentialTypes();
		let availableCount = 0;
		try {
			availableCount = (await this.deps.runtime.getAvailable(providerId)).length;
		} catch {
			availableCount = 0;
		}
		return this.statusOf(providerId, stored, availableCount);
	}

	private statusOf(
		providerId: string,
		stored: Map<string, "api_key" | "oauth">,
		availableModelCount: number,
	): ProviderStatus {
		const provider = this.requireProvider(providerId);
		const status = this.deps.runtime.getProviderAuthStatus(providerId);
		const credentialType = stored.get(providerId);
		const methods: ProviderAuthMethod[] = [];
		if (provider.auth?.apiKey) {
			methods.push({
				type: "api_key",
				name: provider.auth.apiKey.name,
				interactive: provider.auth.apiKey.login !== undefined,
				enabledInPiui: provider.auth.apiKey.login !== undefined,
			});
		}
		if (provider.auth?.oauth) {
			methods.push({
				type: "oauth",
				name: provider.auth.oauth.name,
				interactive: true,
				...(provider.auth.oauth.isSubscription === undefined
					? {}
					: { isSubscription: provider.auth.oauth.isSubscription }),
				...(provider.auth.oauth.loginLabel === undefined
					? {}
					: { loginLabel: provider.auth.oauth.loginLabel }),
				// decision Q1 = B: OAuth stays visible but disabled in V1.
				enabledInPiui: false,
			});
		}
		return {
			id: provider.id,
			name: provider.name,
			configured: status.configured,
			...(status.source ? { source: status.source as CredentialSource } : {}),
			...(status.label ? { label: status.label } : {}),
			...(credentialType ? { credentialType } : {}),
			// A stored credential is always removable, even when it no longer resolves —
			// otherwise a bad key could never be deleted (spec §2.2 "retry or delete").
			removable: credentialType !== undefined || status.source === "stored",
			methods,
			modelCount: this.deps.runtime.getModels(providerId).length,
			availableModelCount,
		};
	}

	private async storedCredentialTypes(): Promise<Map<string, "api_key" | "oauth">> {
		try {
			const credentials = await this.deps.runtime.listCredentials();
			return new Map(credentials.map((c) => [c.providerId, c.type]));
		} catch {
			return new Map();
		}
	}

	private requireProvider(providerId: string) {
		const provider = this.deps.runtime.getProvider(providerId);
		if (!provider) {
			throw new ApiError("provider_not_found", `No provider with id "${providerId}".`);
		}
		return provider;
	}

	// ----------------------------------------------------------------- flows

	async startLogin(
		providerId: string,
		type: "api_key" | "oauth" = "api_key",
		prefill: { apiKey?: string; env?: Record<string, string> } = {},
	): Promise<AuthFlowView> {
		this.sweepFlows();
		const provider = this.requireProvider(providerId);
		if (type === "oauth") {
			throw new ApiError(
				"auth_type_not_supported",
				"OAuth and subscription logins are not available in this version — use the `pi` CLI.",
			);
		}
		if (!provider.auth?.apiKey?.login) {
			throw new ApiError(
				"provider_ambient_only",
				`${provider.name} reads its credentials from the environment; set them where piui runs.`,
			);
		}
		const open = [...this.flows.values()].filter((f) => f.terminalAt === undefined);
		if (open.filter((f) => f.providerId === providerId).length >= MAX_FLOWS_PER_PROVIDER) {
			throw new ApiError("too_many_flows", "Too many login attempts for this provider.");
		}
		if (open.length >= MAX_FLOWS) {
			throw new ApiError("too_many_flows", "Too many login flows are open.");
		}

		const flow: Flow = {
			flowId: this.deps.ids.newId().replace(/-/g, ""),
			providerId,
			state: "working",
			events: [],
			version: 1,
			abort: new AbortController(),
			cancelling: false,
			lastActivity: this.deps.nowMs(),
			secrets: [...(prefill.apiKey ? [prefill.apiKey] : []), ...Object.values(prefill.env ?? {})],
			prefill: { ...(prefill.apiKey ? { apiKey: prefill.apiKey } : {}), env: { ...prefill.env } },
			waiters: [],
		};
		this.flows.set(flow.flowId, flow);

		void this.deps.runtime
			.login(providerId, "api_key", {
				signal: flow.abort.signal,
				prompt: (prompt) => this.onPrompt(flow, prompt),
				notify: (event) => {
					flow.events.push(toUiEvent(event, flow.secrets));
					this.bump(flow);
				},
			})
			.then(
				() => this.finishSuccess(flow),
				(error: unknown) => this.finishFailure(flow, error),
			);

		await this.settle(flow);
		return this.viewOf(flow);
	}

	async respond(flowId: string, promptId: string, value: string): Promise<AuthFlowView> {
		const flow = this.requireFlow(flowId);
		if (flow.state !== "prompting" || !flow.pending) {
			throw new ApiError("flow_not_prompting", "This login step is no longer waiting for input.");
		}
		if (flow.pending.id !== promptId) {
			throw new ApiError("flow_prompt_mismatch", "That answer belongs to an earlier prompt.");
		}
		const pending = flow.pending;
		flow.pending = undefined;
		flow.state = "working";
		flow.secrets.push(value);
		flow.lastActivity = this.deps.nowMs();
		this.bump(flow);
		pending.resolve(value);
		await this.settle(flow);
		return this.viewOf(flow);
	}

	async poll(flowId: string, waitMs: number, since: number): Promise<AuthFlowView> {
		const flow = this.requireFlow(flowId);
		const budget = Math.min(Math.max(waitMs, 0), 30_000);
		const deadline = Date.now() + budget;
		while ((flow.version <= since || flow.state === "working") && Date.now() < deadline) {
			await this.waitForChange(flow, Math.min(deadline - Date.now(), 100));
		}
		return this.viewOf(flow);
	}

	async cancel(flowId: string): Promise<AuthFlowView> {
		const flow = this.requireFlow(flowId);
		if (flow.terminalAt === undefined) {
			flow.cancelling = true;
			flow.pending?.reject(new Error("cancelled"));
			flow.pending = undefined;
			flow.abort.abort();
			// pi may resolve/reject asynchronously; the view is terminal immediately.
			flow.state = "cancelled";
			flow.terminalAt = this.deps.nowMs();
			this.bump(flow);
		}
		return this.viewOf(flow);
	}

	private requireFlow(flowId: string): Flow {
		this.sweepFlows();
		const flow = this.flows.get(flowId);
		if (!flow) throw new ApiError("flow_not_found", "That login flow has expired.");
		return flow;
	}

	private onPrompt(flow: Flow, prompt: unknown): Promise<string> {
		const p = prompt as {
			type: "text" | "secret" | "select" | "manual_code";
			message: string;
			placeholder?: string;
			options?: { id: string; label: string; description?: string }[];
		};
		// Prefill fast path: answer the first `secret` prompt from the pasted key, so the
		// common case is a single HTTP request (spec §2.1).
		if (p.type === "secret" && flow.prefill.apiKey !== undefined) {
			const value = flow.prefill.apiKey;
			flow.prefill.apiKey = undefined;
			return Promise.resolve(value);
		}
		const prefilled = flow.prefill.env[p.message];
		if (prefilled !== undefined) {
			delete flow.prefill.env[p.message];
			return Promise.resolve(prefilled);
		}
		return new Promise<string>((resolve, reject) => {
			const id = this.deps.ids.newId();
			flow.pending = {
				id,
				prompt:
					p.type === "select"
						? { id, type: "select", message: p.message, options: p.options ?? [] }
						: {
								id,
								type: p.type,
								message: p.message,
								...(p.placeholder ? { placeholder: p.placeholder } : {}),
							},
				resolve,
				reject,
			};
			flow.state = "prompting";
			flow.lastActivity = this.deps.nowMs();
			this.bump(flow);
		});
	}

	private async finishSuccess(flow: Flow): Promise<void> {
		if (flow.state === "cancelled") return;
		try {
			this.hardenAuthFile();
			const check = await this.deps.runtime.checkAuth(flow.providerId);
			let warning: string | undefined;
			try {
				const refreshed = await this.deps.runtime.refresh({
					providers: [flow.providerId],
					signal: AbortSignal.timeout(REFRESH_DEADLINE_MS),
				});
				const errors = [...(refreshed.errors ?? new Map())];
				if (errors.length > 0) {
					warning = errors
						.map(
							([id, error]) => `${id}: ${error instanceof Error ? error.message : String(error)}`,
						)
						.join("; ");
				}
			} catch (error) {
				warning = sanitizeMessage(errorMessage(error), flow.secrets);
			}
			const status = await this.providerStatus(flow.providerId);
			this.deps.onMutation();

			// `checkAuth` is the authoritative probe: the snapshot reports a *stored* credential as
			// configured even when the provider refuses it (spike plan/spikes/06 fact 2).
			if (!check) {
				flow.state = "error";
				flow.message =
					"The credential was saved but the provider still reports no working auth — check the key.";
			} else {
				flow.state = "done";
				flow.status = status;
				if (warning) flow.warning = sanitizeMessage(warning, flow.secrets);
				this.deps.logger.info(
					{
						event: "provider_login",
						providerId: flow.providerId,
						type: check?.type ?? "api_key",
						source: status.source ?? null,
						modelCount: status.availableModelCount,
					},
					"provider_login",
				);
			}
		} catch (error) {
			flow.state = "error";
			flow.message = sanitizeMessage(errorMessage(error), flow.secrets);
		}
		this.settleFlow(flow);
	}

	private finishFailure(flow: Flow, error: unknown): void {
		if (flow.state === "cancelled" || flow.cancelling) {
			flow.state = "cancelled";
		} else if (isSynchronizationError(error)) {
			// The credential WAS written; report success with a warning (spec §1.5).
			void this.finishSynchronizationWarning(flow, error);
			return;
		} else {
			flow.state = "error";
			flow.message = sanitizeMessage(errorMessage(error), flow.secrets);
			this.deps.logger.warn(
				{ event: "provider_login_failed", providerId: flow.providerId },
				"provider login failed",
			);
		}
		this.settleFlow(flow);
	}

	private async finishSynchronizationWarning(flow: Flow, error: unknown): Promise<void> {
		this.hardenAuthFile();
		try {
			flow.status = await this.providerStatus(flow.providerId);
		} catch {
			/* status is best effort here */
		}
		flow.state = "done";
		flow.warning = `The credential was saved, but piui could not refresh its model list: ${sanitizeMessage(
			errorMessage(error),
			flow.secrets,
		)}`;
		this.deps.onMutation();
		this.settleFlow(flow);
	}

	private settleFlow(flow: Flow): void {
		flow.pending = undefined;
		flow.terminalAt = this.deps.nowMs();
		flow.secrets = [];
		flow.prefill = { env: {} };
		this.bump(flow);
	}

	// ------------------------------------------------------------ mutations

	async logout(providerId: string): Promise<ProviderStatus> {
		const before = await this.providerStatus(providerId);
		if (!before.removable) {
			const where = before.label ? ` (${before.label})` : "";
			throw new ApiError(
				"credential_not_removable",
				before.configured
					? `${before.name} is configured outside piui${where}; unset ${before.label ?? "it"} where piui runs.`
					: `${before.name} has no stored credential to remove.`,
			);
		}
		let warning: string | undefined;
		try {
			await this.deps.runtime.logout(providerId);
		} catch (error) {
			if (!isSynchronizationError(error)) throw error;
			warning = errorMessage(error);
		}
		this.deps.onMutation();
		this.deps.logger.info(
			{ event: "provider_logout", providerId, warning: warning ?? null },
			"provider_logout",
		);
		return this.providerStatus(providerId);
	}

	async verify(providerId: string): Promise<VerifyProviderResponse> {
		this.requireProvider(providerId);
		try {
			const check = await this.deps.runtime.checkAuth(providerId);
			const status = await this.providerStatus(providerId);
			this.deps.logger.info(
				{ event: "provider_verify", providerId, configured: status.configured },
				"provider_verify",
			);
			return {
				configured: status.configured || check !== undefined,
				models: status.availableModelCount,
				...(check?.source
					? { source: check.source }
					: status.source
						? { source: status.source }
						: {}),
				...(status.label ? { label: status.label } : {}),
			};
		} catch (error) {
			return { configured: false, models: 0, error: sanitizeMessage(errorMessage(error)) };
		}
	}

	/** spec §6: the auth file and its directory must not be group/world readable. */
	private hardenAuthFile(): void {
		if (process.platform === "win32") return;
		try {
			const dir = dirname(this.deps.authPath);
			if (existsSync(dir) && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
			if (existsSync(this.deps.authPath) && (statSync(this.deps.authPath).mode & 0o077) !== 0) {
				chmodSync(this.deps.authPath, 0o600);
			}
		} catch (error) {
			this.deps.logger.warn(
				{ event: "auth_file_chmod_failed", message: errorMessage(error) },
				"could not tighten the auth file permissions",
			);
		}
	}

	// --------------------------------------------------------------- views

	private viewOf(flow: Flow): AuthFlowView {
		const base = { flowId: flow.flowId, providerId: flow.providerId, version: flow.version };
		switch (flow.state) {
			case "prompting":
				return { ...base, state: "prompting", prompt: flow.pending!.prompt, events: flow.events };
			case "done":
				return {
					...base,
					state: "done",
					status: flow.status!,
					...(flow.warning ? { warning: flow.warning } : {}),
					events: flow.events,
				};
			case "error":
				return {
					...base,
					state: "error",
					message: flow.message ?? "The login failed.",
					events: flow.events,
				};
			case "cancelled":
				return { ...base, state: "cancelled", events: flow.events };
			default:
				return { ...base, state: "working", events: flow.events };
		}
	}

	private bump(flow: Flow): void {
		flow.version += 1;
		const waiters = flow.waiters;
		flow.waiters = [];
		for (const waiter of waiters) waiter();
	}

	/** Resolve once the flow stops working (a prompt arrived or it reached a terminal state). */
	private async settle(flow: Flow): Promise<void> {
		const deadline = Date.now() + this.settleBudgetMs;
		while (flow.state === "working" && Date.now() < deadline) {
			await this.waitForChange(flow, 50);
		}
	}

	private waitForChange(flow: Flow, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			timer.unref?.();
			flow.waiters.push(finish);
		});
	}

	private sweepFlows(): void {
		const now = this.deps.nowMs();
		for (const [id, flow] of this.flows) {
			if (flow.terminalAt !== undefined) {
				if (now - flow.terminalAt > FLOW_RETENTION_MS) this.flows.delete(id);
				continue;
			}
			if (now - flow.lastActivity > FLOW_TTL_MS) {
				flow.cancelling = true;
				flow.pending?.reject(new Error("expired"));
				flow.abort.abort();
				this.flows.delete(id);
			}
		}
	}

	/** Graceful shutdown: abort anything in flight. */
	dispose(): void {
		for (const flow of this.flows.values()) {
			flow.cancelling = true;
			flow.pending?.reject(new Error("shutting down"));
			flow.abort.abort();
		}
		this.flows.clear();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isSynchronizationError(error: unknown): boolean {
	return error instanceof Error && error.name === "CredentialSynchronizationError";
}

function toUiEvent(event: unknown, secrets: readonly string[]): UiAuthEvent {
	const e = event as Record<string, unknown>;
	switch (e.type) {
		case "auth_url":
			return {
				type: "auth_url",
				url: String(e.url),
				...(e.instructions ? { instructions: String(e.instructions) } : {}),
			};
		case "device_code":
			return {
				type: "device_code",
				userCode: String(e.userCode),
				verificationUri: String(e.verificationUri),
				...(typeof e.intervalSeconds === "number" ? { intervalSeconds: e.intervalSeconds } : {}),
				...(typeof e.expiresInSeconds === "number" ? { expiresInSeconds: e.expiresInSeconds } : {}),
			};
		case "progress":
			return { type: "progress", message: sanitizeMessage(String(e.message), secrets) };
		default:
			return {
				type: "info",
				message: sanitizeMessage(String(e.message ?? ""), secrets),
				...(Array.isArray(e.links)
					? {
							links: (e.links as { url: string; label?: string }[]).map((l) => ({
								url: l.url,
								...(l.label ? { label: l.label } : {}),
							})),
						}
					: {}),
			};
	}
}
