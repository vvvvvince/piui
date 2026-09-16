// spec/14-credentials.md §3 — the credential HTTP surface (replaces spec/09-api.md §3).
// Authentication, the admin role and step-up are enforced globally in http/auth.ts.
import { homedir } from "node:os";
import type {
	AuthFlowView,
	ProviderStatus,
	ProvidersResponse,
	VerifyProviderResponse,
} from "@piui/shared";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../../context.js";
import type { Services } from "../../services.js";
import type { PiuiFastify } from "../auth.js";
import { ApiError } from "../errors.js";
import { SlidingWindowLimiter } from "../rate-limit.js";

const MUTATIONS_PER_HOUR = 20;

/** Paths are shown in the UI so the user knows where keys land; abbreviate $HOME. */
export function abbreviateHome(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export async function registerProviderRoutes(
	app: PiuiFastify,
	ctx: AppContext,
	services: Services,
): Promise<void> {
	const limiter = new SlidingWindowLimiter(
		() => ctx.clock.nowMs(),
		MUTATIONS_PER_HOUR,
		60 * 60 * 1000,
	);

	/** Every credential *write* passes here first (spec §7.1-7.2, §5). */
	const guardWrite = (req: FastifyRequest): void => {
		if (ctx.config.disableCredentialWrites) {
			throw new ApiError(
				"credential_writes_disabled",
				"Credential writes are disabled on this deployment (PIUI_DISABLE_CREDENTIAL_WRITES=1).",
			);
		}
		const https = req.protocol === "https";
		if (ctx.config.allowRemote && !https && !ctx.config.insecureTransportOk) {
			throw new ApiError(
				"insecure_transport",
				"Refusing to accept a credential over plaintext HTTP on a remotely reachable server.",
			);
		}
		if (!limiter.take(req.sessionId ?? req.ip)) {
			throw new ApiError("rate_limited", "Too many credential changes. Try again later.");
		}
	};

	app.get("/api/providers", async (): Promise<ProvidersResponse> => {
		return {
			items: await services.credentials.listProviders(),
			credentialWritesEnabled: !ctx.config.disableCredentialWrites,
			authPath: abbreviateHome(ctx.config.piAuthPath),
		};
	});

	app.post<{
		Params: { id: string };
		Body: { type?: "api_key" | "oauth"; apiKey?: string; env?: Record<string, string> };
	}>(
		"/api/providers/:id/auth/start",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					properties: {
						type: { type: "string", enum: ["api_key", "oauth"] },
						apiKey: { type: "string" },
						env: { type: "object", additionalProperties: { type: "string" } },
					},
				},
			},
		},
		async (req): Promise<AuthFlowView> => {
			guardWrite(req);
			const body = req.body ?? {};
			return services.credentials.startLogin(req.params.id, body.type ?? "api_key", {
				...(body.apiKey ? { apiKey: body.apiKey } : {}),
				...(body.env ? { env: body.env } : {}),
			});
		},
	);

	app.post<{
		Params: { id: string };
		Body: { flowId: string; promptId: string; value: string };
	}>(
		"/api/providers/:id/auth/respond",
		{
			schema: {
				body: {
					type: "object",
					required: ["flowId", "promptId", "value"],
					additionalProperties: false,
					properties: {
						flowId: { type: "string" },
						promptId: { type: "string" },
						value: { type: "string" },
					},
				},
			},
		},
		async (req): Promise<AuthFlowView> => {
			guardWrite(req);
			return services.credentials.respond(req.body.flowId, req.body.promptId, req.body.value);
		},
	);

	app.get<{ Params: { flowId: string }; Querystring: { wait?: string; since?: string } }>(
		"/api/providers/auth-flows/:flowId",
		async (req): Promise<AuthFlowView> => {
			const wait = Number(req.query.wait ?? 0);
			const since = Number(req.query.since ?? 0);
			return services.credentials.poll(
				req.params.flowId,
				Number.isFinite(wait) ? wait : 0,
				Number.isFinite(since) ? since : 0,
			);
		},
	);

	app.post<{ Params: { id: string }; Body: { flowId: string } }>(
		"/api/providers/:id/auth/cancel",
		{
			schema: {
				body: {
					type: "object",
					required: ["flowId"],
					additionalProperties: false,
					properties: { flowId: { type: "string" } },
				},
			},
		},
		async (req): Promise<AuthFlowView> => {
			guardWrite(req);
			return services.credentials.cancel(req.body.flowId);
		},
	);

	app.delete<{ Params: { id: string } }>(
		"/api/providers/:id/auth",
		async (req): Promise<ProviderStatus> => {
			guardWrite(req);
			return services.credentials.logout(req.params.id);
		},
	);

	app.post<{ Params: { id: string } }>(
		"/api/providers/:id/verify",
		async (req): Promise<VerifyProviderResponse> => {
			// `verify` writes nothing, so it stays available even when writes are disabled.
			return services.credentials.verify(req.params.id);
		},
	);
	// spec §7.3: request bodies are never logged anywhere in piui (the single request log line
	// in http/server.ts carries method/url/status only), so there is nothing to opt out of here.
}
