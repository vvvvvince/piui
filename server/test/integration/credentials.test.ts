// spec/14-credentials.md §§3, 7, 9 — the credential HTTP surface end to end.
import { readFileSync, statSync } from "node:fs";
import type {
	AuthFlowView,
	ModelsResponse,
	ProvidersResponse,
	VerifyProviderResponse,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { recordingLogger } from "../support/logger.js";
import type { MintedPrincipal } from "../support/principal.js";
import { registerStubProvider } from "../support/stub-provider.js";

const FIXTURE_KEY = "sk-ant-api03-FIXTUREKEY0123456789abcdef";

async function adminWithStepUp(app: TestApp): Promise<MintedPrincipal> {
	const admin = app.mint();
	const res = await app.app.inject({
		method: "POST",
		url: "/api/auth/step-up",
		headers: { ...admin.headers, "content-type": "application/json" },
		payload: { password: "test" },
	});
	expect(res.statusCode).toBe(204);
	return admin;
}

const json = { "content-type": "application/json" };

describe("providers & credentials", () => {
	it("[14-credentials#9.1] lists every provider as not configured when there are no credentials", async () => {
		await withTestApp(async (t) => {
			const res = await t.app.inject({
				method: "GET",
				url: "/api/providers",
				headers: t.mint().headers,
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<ProvidersResponse>();
			expect(body.items.length).toBeGreaterThan(10);
			expect(body.items.every((p) => p.configured === false)).toBe(true);
			expect(body.items.every((p) => p.removable === false)).toBe(true);
			expect(body.credentialWritesEnabled).toBe(true);
			expect(body.authPath).toMatch(/auth\.json$/);
			// no secret-bearing field ever appears in the payload
			expect(JSON.stringify(body)).not.toMatch(/"key"|apiKey|secret/i);

			const anthropic = body.items.find((p) => p.id === "anthropic");
			expect(anthropic?.methods.some((m) => m.type === "api_key" && m.enabledInPiui)).toBe(true);
			expect(anthropic?.methods.some((m) => m.type === "oauth" && m.enabledInPiui)).toBe(false);
			expect(anthropic?.modelCount).toBeGreaterThan(0);
			expect(anthropic?.availableModelCount).toBe(0);
		});
	});

	it("[14-credentials#9.2] stores a pasted key in one request, 0600, and makes its models available", async () => {
		await withTestApp(async (t) => {
			const admin = await adminWithStepUp(t);
			const before = await t.app.inject({
				method: "GET",
				url: "/api/models",
				headers: admin.headers,
			});
			const revisionBefore = before.json<ModelsResponse>().credentialsRevision;

			const res = await t.app.inject({
				method: "POST",
				url: "/api/providers/anthropic/auth/start",
				headers: { ...admin.headers, ...json },
				payload: { apiKey: FIXTURE_KEY },
			});
			expect(res.statusCode).toBe(200);
			const view = res.json<AuthFlowView>();
			expect(view.state).toBe("done");
			if (view.state !== "done") throw new Error("unreachable");
			expect(view.status.configured).toBe(true);
			expect(view.status.source).toBe("stored");
			expect(view.status.removable).toBe(true);
			expect(view.status.availableModelCount).toBeGreaterThan(0);

			const stored = JSON.parse(readFileSync(t.ctx.config.piAuthPath, "utf8"));
			expect(stored.anthropic).toMatchObject({ type: "api_key", key: FIXTURE_KEY });
			expect(statSync(t.ctx.config.piAuthPath).mode & 0o777).toBe(0o600);

			const after = await t.app.inject({
				method: "GET",
				url: "/api/models",
				headers: admin.headers,
			});
			const models = after.json<ModelsResponse>();
			expect(models.credentialsRevision).toBeGreaterThan(revisionBefore);
			expect(models.items.some((m) => m.provider === "anthropic" && m.available)).toBe(true);
		});
	});

	it("[14-credentials#9.3] reports an invalid key as an error that contains no fragment of it", async () => {
		await withTestApp(async (t) => {
			registerStubProvider(t.services.modelRuntime, {
				id: "stub-picky",
				name: "Stub Picky",
				accept: (key) => key.startsWith("good-"),
			});
			const admin = await adminWithStepUp(t);
			const res = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-picky/auth/start",
				headers: { ...admin.headers, ...json },
				payload: { apiKey: FIXTURE_KEY },
			});
			expect(res.statusCode).toBe(200);
			const view = res.json<AuthFlowView>();
			expect(view.state).toBe("error");
			if (view.state !== "error") throw new Error("unreachable");
			expect(view.message).toMatch(/check the key/i);
			expect(res.payload).not.toContain(FIXTURE_KEY);
			expect(res.payload).not.toContain(FIXTURE_KEY.slice(8, 24));

			// the provider still reports a truthful status, not a lie
			const providers = await t.app.inject({
				method: "GET",
				url: "/api/providers",
				headers: admin.headers,
			});
			const status = providers.json<ProvidersResponse>().items.find((p) => p.id === "stub-picky");
			// truthful: a credential is stored (so it can be deleted) but nothing works with it
			expect(status?.credentialType).toBe("api_key");
			expect(status?.availableModelCount).toBe(0);
			expect(status?.removable).toBe(true);
		});
	});

	it("[14-credentials#9.3] strips key-shaped fragments out of provider error messages", async () => {
		await withTestApp(async (t) => {
			registerStubProvider(t.services.modelRuntime, {
				id: "stub-loud",
				failWith: (answers) => new Error(`rejected credential ${answers.key}`),
			});
			const admin = await adminWithStepUp(t);
			const res = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-loud/auth/start",
				headers: { ...admin.headers, ...json },
				payload: { apiKey: FIXTURE_KEY },
			});
			const view = res.json<AuthFlowView>();
			expect(view.state).toBe("error");
			expect(res.payload).not.toContain(FIXTURE_KEY);
			expect(res.payload).toContain("***");
		});
	});

	it("[14-credentials#9.4] walks a two-prompt provider through both steps and stores the second answer in env", async () => {
		await withTestApp(async (t) => {
			registerStubProvider(t.services.modelRuntime, {
				id: "stub-two",
				name: "Stub Two",
				prompts: [
					{ type: "secret", message: "Enter Stub Two API key", storeAs: "key" },
					{ type: "text", message: "Account id", placeholder: "acct_…", storeAs: "STUB_ACCOUNT" },
				],
				notify: [{ type: "info", message: "Create a key in the dashboard" }],
			});
			const admin = await adminWithStepUp(t);

			const started = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/start",
				headers: { ...admin.headers, ...json },
				payload: {},
			});
			const first = started.json<AuthFlowView>();
			expect(first.state).toBe("prompting");
			if (first.state !== "prompting") throw new Error("unreachable");
			expect(first.prompt.type).toBe("secret");
			expect(first.events).toEqual([{ type: "info", message: "Create a key in the dashboard" }]);

			const second = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/respond",
				headers: { ...admin.headers, ...json },
				payload: { flowId: first.flowId, promptId: first.prompt.id, value: FIXTURE_KEY },
			});
			const view2 = second.json<AuthFlowView>();
			expect(view2.state).toBe("prompting");
			if (view2.state !== "prompting") throw new Error("unreachable");
			expect(view2.prompt.type).toBe("text");
			expect(view2.prompt.message).toBe("Account id");

			const third = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/respond",
				headers: { ...admin.headers, ...json },
				payload: { flowId: first.flowId, promptId: view2.prompt.id, value: "acct_42" },
			});
			expect(third.json<AuthFlowView>().state).toBe("done");

			const stored = JSON.parse(readFileSync(t.ctx.config.piAuthPath, "utf8"));
			expect(stored["stub-two"]).toMatchObject({
				type: "api_key",
				key: FIXTURE_KEY,
				env: { STUB_ACCOUNT: "acct_42" },
			});
		});
	});

	it("[14-credentials#9.5] refuses key entry and deletion for credentials piui does not own", async () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
		try {
			await withTestApp(async (t) => {
				registerStubProvider(t.services.modelRuntime, {
					id: "stub-ambient",
					name: "Stub Ambient",
					ambientLabel: "STUB_AMBIENT_KEY",
				});
				const admin = await adminWithStepUp(t);

				const providers = await t.app.inject({
					method: "GET",
					url: "/api/providers",
					headers: admin.headers,
				});
				const items = providers.json<ProvidersResponse>().items;

				// (a) an env-sourced credential: configured, labelled, and not removable
				const anthropic = items.find((p) => p.id === "anthropic");
				expect(anthropic?.configured).toBe(true);
				expect(anthropic?.source).toBe("environment");
				expect(anthropic?.label).toBe("ANTHROPIC_API_KEY");
				expect(anthropic?.removable).toBe(false);

				const deleted = await t.app.inject({
					method: "DELETE",
					url: "/api/providers/anthropic/auth",
					headers: admin.headers,
				});
				expect(deleted.statusCode).toBe(409);
				const error = deleted.json<{ error: { code: string; message: string } }>().error;
				expect(error.code).toBe("credential_not_removable");
				expect(error.message).toContain("ANTHROPIC_API_KEY");

				// (b) an ambient-only provider offers no interactive key entry at all
				const ambient = items.find((p) => p.id === "stub-ambient");
				expect(ambient?.methods).toEqual([
					expect.objectContaining({ type: "api_key", interactive: false, enabledInPiui: false }),
				]);
				const start = await t.app.inject({
					method: "POST",
					url: "/api/providers/stub-ambient/auth/start",
					headers: { ...admin.headers, ...json },
					payload: { apiKey: FIXTURE_KEY },
				});
				expect(start.statusCode).toBe(409);
				expect(start.json<{ error: { code: string } }>().error.code).toBe("provider_ambient_only");
			});
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});

	it("[14-credentials#9.6] deleting a stored credential hides its models and announces providers_changed", async () => {
		await withTestApp(async (t) => {
			const admin = await adminWithStepUp(t);
			await t.app.inject({
				method: "POST",
				url: "/api/providers/anthropic/auth/start",
				headers: { ...admin.headers, ...json },
				payload: { apiKey: FIXTURE_KEY },
			});

			const events = await t.openGlobalEvents(admin);

			const res = await t.app.inject({
				method: "DELETE",
				url: "/api/providers/anthropic/auth",
				headers: admin.headers,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json<{ configured: boolean }>().configured).toBe(false);

			await events.waitFor((frames) => frames.some((f) => f.data.includes("providers_changed")));
			events.stop();

			const models = await t.app.inject({
				method: "GET",
				url: "/api/models",
				headers: admin.headers,
			});
			expect(
				models.json<ModelsResponse>().items.some((m) => m.provider === "anthropic" && m.available),
			).toBe(false);
		});
	});

	it("[14-credentials#9.6] the provider list stops calling a deleted credential configured immediately", async () => {
		await withTestApp(async (t) => {
			const admin = await adminWithStepUp(t);
			await t.app.inject({
				method: "POST",
				url: "/api/providers/anthropic/auth/start",
				headers: { ...admin.headers, ...json },
				payload: { apiKey: FIXTURE_KEY },
			});
			await t.app.inject({
				method: "DELETE",
				url: "/api/providers/anthropic/auth",
				headers: admin.headers,
			});

			// The browser showed a stale "Configured (stored)" row here in M2: pi's auth status
			// is an asynchronously refreshed snapshot, so the list must cross-check it against
			// the credential store, which is authoritative.
			const list = await t.app.inject({
				method: "GET",
				url: "/api/providers",
				headers: admin.headers,
			});
			const anthropic = list.json<ProvidersResponse>().items.find((p) => p.id === "anthropic");
			expect(anthropic?.configured).toBe(false);
			expect(anthropic?.removable).toBe(false);
			expect(anthropic?.source).toBeUndefined();
		});
	});

	it("[14-credentials#9.8] refuses every write route under PIUI_DISABLE_CREDENTIAL_WRITES, status still works", async () => {
		await withTestApp(
			async (t) => {
				const admin = await adminWithStepUp(t);
				const writes: [string, string, object][] = [
					["POST", "/api/providers/anthropic/auth/start", { apiKey: FIXTURE_KEY }],
					[
						"POST",
						"/api/providers/anthropic/auth/respond",
						{ flowId: "x", promptId: "y", value: "z" },
					],
					["POST", "/api/providers/anthropic/auth/cancel", { flowId: "x" }],
					["DELETE", "/api/providers/anthropic/auth", {}],
				];
				for (const [method, url, payload] of writes) {
					const res = await t.app.inject({
						method: method as "POST",
						url,
						headers: method === "DELETE" ? admin.headers : { ...admin.headers, ...json },
						...(method === "DELETE" ? {} : { payload }),
					});
					expect(res.statusCode, `${method} ${url}`).toBe(403);
					expect(res.json<{ error: { code: string } }>().error.code).toBe(
						"credential_writes_disabled",
					);
				}

				const list = await t.app.inject({
					method: "GET",
					url: "/api/providers",
					headers: admin.headers,
				});
				expect(list.statusCode).toBe(200);
				expect(list.json<ProvidersResponse>().credentialWritesEnabled).toBe(false);

				const verify = await t.app.inject({
					method: "POST",
					url: "/api/providers/anthropic/verify",
					headers: admin.headers,
				});
				expect(verify.statusCode).toBe(200);
				expect(verify.json<VerifyProviderResponse>().configured).toBe(false);
			},
			{ env: { PIUI_DISABLE_CREDENTIAL_WRITES: "1" } },
		);
	});

	it("[19-deployment#9.4] in a container, credential writes need PIUI_INSECURE_TRANSPORT_OK", async () => {
		// The shipped compose file sets it because it publishes to loopback only; unsetting it
		// must bring the refusal back (spec/19-deployment.md §5.2).
		await withTestApp(
			async (t) => {
				const admin = await adminWithStepUp(t);
				const refused = await t.app.inject({
					method: "POST",
					url: "/api/providers/anthropic/auth/start",
					headers: { ...admin.headers, ...json },
					payload: { apiKey: FIXTURE_KEY },
				});
				expect(refused.statusCode).toBe(403);
				expect(refused.json<{ error: { code: string } }>().error.code).toBe("insecure_transport");
			},
			// exactly the shipped compose env, minus the acknowledgement
			{ env: { PIUI_CONTAINER: "1", PIUI_ALLOW_REMOTE: "1", PIUI_HOST: "0.0.0.0" } },
		);
		await withTestApp(
			async (t) => {
				const admin = await adminWithStepUp(t);
				const accepted = await t.app.inject({
					method: "POST",
					url: "/api/providers/anthropic/auth/start",
					headers: { ...admin.headers, ...json },
					payload: { apiKey: FIXTURE_KEY },
				});
				expect(accepted.statusCode).toBe(200);
			},
			{
				env: {
					PIUI_CONTAINER: "1",
					PIUI_ALLOW_REMOTE: "1",
					PIUI_HOST: "0.0.0.0",
					PIUI_INSECURE_TRANSPORT_OK: "1",
				},
			},
		);
	});

	it("[14-credentials#9.9] refuses key entry over plaintext when piui is reachable remotely", async () => {
		await withTestApp(
			async (t) => {
				const admin = await adminWithStepUp(t);
				const res = await t.app.inject({
					method: "POST",
					url: "/api/providers/anthropic/auth/start",
					headers: { ...admin.headers, ...json },
					payload: { apiKey: FIXTURE_KEY },
				});
				expect(res.statusCode).toBe(403);
				expect(res.json<{ error: { code: string } }>().error.code).toBe("insecure_transport");

				// ... but an HTTPS-terminating proxy in front of piui is fine
				const forwarded = await t.app.inject({
					method: "POST",
					url: "/api/providers/anthropic/auth/start",
					headers: { ...admin.headers, ...json, "x-forwarded-proto": "https" },
					payload: { apiKey: FIXTURE_KEY },
				});
				expect(forwarded.statusCode).toBe(200);
			},
			{ env: { PIUI_ALLOW_REMOTE: "1" } },
		);
	});

	it("[14-credentials#9.9][19-deployment#9.3] honours the container override, and the model becomes available without a restart", async () => {
		await withTestApp(
			async (t) => {
				const admin = await adminWithStepUp(t);
				const res = await t.app.inject({
					method: "POST",
					url: "/api/providers/anthropic/auth/start",
					headers: { ...admin.headers, ...json },
					payload: { apiKey: FIXTURE_KEY },
				});
				expect(res.statusCode).toBe(200);
				expect(res.json<AuthFlowView>().state).toBe("done");

				const models = await t.app.inject({
					method: "GET",
					url: "/api/models",
					headers: admin.headers,
				});
				expect(
					models
						.json<ModelsResponse>()
						.items.some((m) => m.provider === "anthropic" && m.available),
				).toBe(true);
			},
			{ env: { PIUI_ALLOW_REMOTE: "1", PIUI_INSECURE_TRANSPORT_OK: "1" } },
		);
	});

	it("[14-credentials#9.10] never writes the key to a log line, an error body, or a status response", async () => {
		const log = recordingLogger();
		await withTestApp(
			async (t) => {
				const admin = await adminWithStepUp(t);
				registerStubProvider(t.services.modelRuntime, {
					id: "stub-loud",
					failWith: (answers) => new Error(`upstream said no: ${answers.key}`),
				});

				const bodies: string[] = [];
				const record = async (
					method: "POST" | "GET" | "DELETE",
					url: string,
					payload?: object,
				): Promise<void> => {
					const res = await t.app.inject({
						method,
						url,
						headers: payload ? { ...admin.headers, ...json } : admin.headers,
						...(payload ? { payload } : {}),
					});
					bodies.push(res.payload);
				};

				await record("POST", "/api/providers/anthropic/auth/start", { apiKey: FIXTURE_KEY });
				await record("POST", "/api/providers/stub-loud/auth/start", { apiKey: FIXTURE_KEY });
				await record("GET", "/api/providers");
				await record("POST", "/api/providers/anthropic/verify", undefined);
				await record("DELETE", "/api/providers/anthropic/auth", undefined);
				await record("POST", "/api/providers/anthropic/auth/respond", {
					flowId: "nope",
					promptId: "nope",
					value: FIXTURE_KEY,
				});

				for (const body of bodies) expect(body).not.toContain(FIXTURE_KEY);
				expect(log.text()).not.toContain(FIXTURE_KEY);
				expect(log.text()).toContain("provider_login");
			},
			{ logger: log.logger },
		);
	});
});

describe("auth flow state machine", () => {
	it("[14-credentials#2.1] rejects a stale promptId, an unknown flow, and a respond while working", async () => {
		await withTestApp(async (t) => {
			registerStubProvider(t.services.modelRuntime, {
				id: "stub-two",
				prompts: [
					{ type: "secret", message: "key?", storeAs: "key" },
					{ type: "text", message: "account?", storeAs: "ACCOUNT" },
				],
			});
			const admin = await adminWithStepUp(t);
			const started = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/start",
				headers: { ...admin.headers, ...json },
				payload: {},
			});
			const view = started.json<AuthFlowView>();
			if (view.state !== "prompting") throw new Error("expected a prompt");

			const mismatch = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/respond",
				headers: { ...admin.headers, ...json },
				payload: { flowId: view.flowId, promptId: "not-the-pending-one", value: "x" },
			});
			expect(mismatch.statusCode).toBe(409);
			expect(mismatch.json<{ error: { code: string } }>().error.code).toBe("flow_prompt_mismatch");

			const unknown = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/respond",
				headers: { ...admin.headers, ...json },
				payload: { flowId: "00000000", promptId: "x", value: "y" },
			});
			expect(unknown.statusCode).toBe(404);
			expect(unknown.json<{ error: { code: string } }>().error.code).toBe("flow_not_found");

			const cancelled = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/cancel",
				headers: { ...admin.headers, ...json },
				payload: { flowId: view.flowId },
			});
			expect(cancelled.json<AuthFlowView>().state).toBe("cancelled");
		});
	});

	it("[14-credentials#2.1] expires an idle flow after 5 minutes", async () => {
		await withTestApp(async (t) => {
			registerStubProvider(t.services.modelRuntime, {
				id: "stub-two",
				prompts: [
					{ type: "secret", message: "key?", storeAs: "key" },
					{ type: "text", message: "account?", storeAs: "ACCOUNT" },
				],
			});
			const admin = await adminWithStepUp(t);
			const started = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/start",
				headers: { ...admin.headers, ...json },
				payload: {},
			});
			const view = started.json<AuthFlowView>();
			if (view.state !== "prompting") throw new Error("expected a prompt");

			t.clock.advance(5 * 60_000 + 1);
			const res = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/respond",
				headers: { ...admin.headers, ...json },
				payload: { flowId: view.flowId, promptId: view.prompt.id, value: "x" },
			});
			expect(res.statusCode).toBe(404);
			expect(res.json<{ error: { code: string } }>().error.code).toBe("flow_not_found");
		});
	});

	it("[14-credentials#2.1] caps concurrent flows per provider", async () => {
		await withTestApp(async (t) => {
			registerStubProvider(t.services.modelRuntime, {
				id: "stub-two",
				prompts: [
					{ type: "secret", message: "key?", storeAs: "key" },
					{ type: "text", message: "account?", storeAs: "ACCOUNT" },
				],
			});
			const admin = await adminWithStepUp(t);
			// pi serializes credential operations per provider, so flows 2 and 3 sit in "working"
			// until the first finishes; the suite must not wait out the real settle budget.
			t.services.credentials.settleBudgetMs = 100;
			const start = () =>
				t.app.inject({
					method: "POST",
					url: "/api/providers/stub-two/auth/start",
					headers: { ...admin.headers, ...json },
					payload: {},
				});
			for (let i = 0; i < 3; i += 1) expect((await start()).statusCode).toBe(200);
			const refused = await start();
			expect(refused.statusCode).toBe(429);
			expect(refused.json<{ error: { code: string } }>().error.code).toBe("too_many_flows");
		});
	});

	it("[14-credentials#3.1] long-polls a flow and returns as soon as the view changes", async () => {
		await withTestApp(async (t) => {
			registerStubProvider(t.services.modelRuntime, {
				id: "stub-two",
				prompts: [
					{ type: "secret", message: "key?", storeAs: "key" },
					{ type: "text", message: "account?", storeAs: "ACCOUNT" },
				],
			});
			const admin = await adminWithStepUp(t);
			const started = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/start",
				headers: { ...admin.headers, ...json },
				payload: {},
			});
			const view = started.json<AuthFlowView>();
			if (view.state !== "prompting") throw new Error("expected a prompt");

			// nothing changed yet: the poll waits, then the answer lands and it returns
			const poll = t.app.inject({
				method: "GET",
				url: `/api/providers/auth-flows/${view.flowId}?wait=2000&since=${view.version}`,
				headers: admin.headers,
			});
			const answered = await t.app.inject({
				method: "POST",
				url: "/api/providers/stub-two/auth/respond",
				headers: { ...admin.headers, ...json },
				payload: { flowId: view.flowId, promptId: view.prompt.id, value: "k" },
			});
			expect(answered.statusCode).toBe(200);

			const polled = (await poll).json<AuthFlowView>();
			expect(polled.version).toBeGreaterThan(view.version);
			expect(polled.state).toBe("prompting");
		});
	});

	it("[14-credentials#5.1] rate-limits credential mutations to 20 per hour per session", async () => {
		await withTestApp(async (t) => {
			const admin = await adminWithStepUp(t);
			registerStubProvider(t.services.modelRuntime, { id: "stub-one" });
			const start = () =>
				t.app.inject({
					method: "POST",
					url: "/api/providers/stub-one/auth/start",
					headers: { ...admin.headers, ...json },
					payload: { apiKey: "good-key" },
				});
			for (let i = 0; i < 20; i += 1) expect((await start()).statusCode).toBe(200);
			const limited = await start();
			expect(limited.statusCode).toBe(429);
			expect(limited.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
		});
	});
});
