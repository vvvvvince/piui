import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { HealthResponse, MetaResponse } from "@piui/shared";
import Fastify from "fastify";
import { auditAction, outcomeForStatus } from "../audit.js";
import type { AppContext } from "../context.js";
import { ForbiddenError, NotFoundError } from "../db/repositories/base.js";
import { createServices, type Services } from "../services.js";
import { LoginRateLimiter, registerAuth } from "./auth.js";
import { ApiError } from "./errors.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerGlobalEventRoutes } from "./routes/events.js";
import { registerExtensionRoutes } from "./routes/extensions.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { securityHeaders } from "./security.js";

declare module "fastify" {
	interface FastifyInstance {
		/** Process-wide services (pi runtime, credentials, models, hub). */
		piui: Services;
	}
}

export type PiuiServer = Awaited<ReturnType<typeof buildServer>>;

/** Fastify's content-type-parser refusals, said in the error envelope's voice. */
function transportErrorMessage(code: string): string {
	switch (code) {
		case "FST_ERR_CTP_EMPTY_JSON_BODY":
			return "The request body is empty. Send a JSON body, or drop the content-type header.";
		case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
			return "Unsupported content-type for this route.";
		case "FST_ERR_CTP_BODY_TOO_LARGE":
			return "The request body is too large.";
		default:
			return "The request body could not be read.";
	}
}

export async function buildServer(ctx: AppContext, injected?: Services) {
	const { config } = ctx;
	const app = Fastify({
		loggerInstance: ctx.logger,
		// piui logs exactly one line per request, in the onResponse hook below.
		// (fastify@6 will want `logController`; its typings do not accept a subclass yet.)
		disableRequestLogging: true,
		trustProxy: true,
		genReqId: () => ctx.ids.newId(),
	});

	await app.register(fastifyCookie, { secret: config.sessionSecret });
	// Uploads (spec/09-api.md §10) and skill zip import (spec/05 §A.4). The transport cap is
	// deliberately generous: both domains enforce their own limit and report it in the envelope.
	await app.register(fastifyMultipart, {
		limits: { files: 1, fileSize: Math.max(config.maxUploadMb, 64) * 1024 * 1024 },
	});

	// spec/11-security.md §4 — on every response, before anything can answer.
	const headers = securityHeaders(config);
	app.addHook("onRequest", (_req, reply, done) => {
		for (const [name, value] of Object.entries(headers)) reply.header(name, value);
		done();
	});

	const loginLimiter = new LoginRateLimiter(() => ctx.clock.nowMs());
	await registerAuth(app, { ctx, provider: ctx.authProvider, limiter: loginLimiter });

	// spec/11-security.md §7 — one audit line per mutation, whatever the outcome. A hook rather
	// than per-route calls: a route added later is audited by construction.
	app.addHook("onResponse", (req, reply, done) => {
		const mutation = auditAction(req.method, req.url);
		if (mutation) {
			ctx.audit.record({
				actor: req.principal?.id ?? "anonymous",
				action: mutation.action,
				target: mutation.target,
				outcome: outcomeForStatus(reply.statusCode),
				status: reply.statusCode,
			});
		}
		done();
	});

	// One log line per request (spec/01-architecture.md §1).
	app.addHook("onResponse", (req, reply, done) => {
		req.log.info(
			{
				method: req.method,
				url: req.url,
				status: reply.statusCode,
				ms: Math.round(reply.elapsedTime),
			},
			"request",
		);
		done();
	});

	app.setErrorHandler((rawError, req, reply) => {
		const error = rawError as Error & {
			statusCode?: number;
			validation?: { instancePath?: string; schemaPath?: string; message?: string }[];
		};
		if (error instanceof ApiError) {
			reply.status(error.statusCode).send(error.toBody());
			return;
		}
		if (error instanceof NotFoundError) {
			reply.status(404).send(new ApiError("not_found", error.message).toBody());
			return;
		}
		if (error instanceof ForbiddenError) {
			reply.status(403).send(new ApiError("forbidden", error.message).toBody());
			return;
		}
		// Transport-level refusals (an empty JSON body, an unsupported media type, a body over the
		// limit) are the client's fault and must read like it — found in the browser in M5c, where a
		// DELETE with `content-type: application/json` and no body answered `400 internal_error`.
		const fastifyCode = (error as { code?: string }).code;
		if (typeof fastifyCode === "string" && fastifyCode.startsWith("FST_ERR_CTP_")) {
			reply
				.status(400)
				.send(new ApiError("validation_error", transportErrorMessage(fastifyCode)).toBody());
			return;
		}
		if (error.validation) {
			reply.status(400).send(
				new ApiError(
					"validation_error",
					"Request body failed validation.",
					error.validation.map((v) => ({
						path: String(v.instancePath || v.schemaPath),
						message: v.message ?? "invalid",
					})),
				).toBody(),
			);
			return;
		}
		// spec/11-security.md §8 — the stack stays in the server log; the client gets a code and
		// the correlation id that finds that log line.
		const correlationId = String(req.id);
		req.log.error({ err: error, correlationId }, "unhandled error");
		const body = new ApiError("internal_error", "Something went wrong on the server.").toBody();
		reply
			.status(error.statusCode && error.statusCode >= 500 ? error.statusCode : 500)
			.send({ error: { ...body.error, correlationId } });
	});

	app.setNotFoundHandler((req, reply) => {
		if (req.url.startsWith("/api/")) {
			reply
				.status(404)
				.send(new ApiError("not_found", `No route for ${req.method} ${req.url}.`).toBody());
			return;
		}
		// SPA fallback in production.
		if (ctx.serveClient) {
			reply.sendFile("index.html");
			return;
		}
		reply.status(404).send(new ApiError("not_found", "Not found.").toBody());
	});

	app.get("/api/health", async (): Promise<HealthResponse> => {
		return {
			ok: true,
			version: ctx.version,
			piVersion: ctx.piVersion,
			defaultCredentials: config.defaultCredentials,
			container: config.container,
			insecureTransportOk: config.insecureTransportOk,
		};
	});

	app.get("/api/meta", async (): Promise<MetaResponse> => {
		return {
			searchProvider: {
				id: config.searchProvider,
				configured:
					config.searchProvider === "none"
						? false
						: config.searchProvider === "searxng"
							? Boolean(config.searxngUrl)
							: Boolean(config.searchApiKey),
			},
			workspaceRoots: [...config.workspaceRoots],
			limits: {
				maxUploadMb: config.maxUploadMb,
				maxConcurrentRuns: config.maxConcurrentRuns,
				maxRunMinutes: config.maxRunMinutes,
			},
			platform: process.platform,
		};
	});

	const services = injected ?? (await createServices(ctx));
	app.decorate("piui", services);
	app.addHook("onClose", async () => {
		await services.dispose();
	});

	await registerProviderRoutes(app, ctx, services);
	await registerModelRoutes(app, services);
	await registerGlobalEventRoutes(app, services);
	await registerToolRoutes(app, ctx, services);
	await registerWorkspaceRoutes(app, services.workspaces, services.commands);
	await registerProfileRoutes(app, services.profiles);
	await registerSkillRoutes(app, ctx, services.skillWrites, services.skillTests);
	await registerUploadRoutes(app, services);
	await registerConversationRoutes(app, services.conversations, services.hub, services.commands);
	await registerPromptRoutes(app, services.commands);
	await registerExtensionRoutes(app, services.extensions);

	if (ctx.serveClient && existsSync(join(config.clientDist, "index.html"))) {
		await app.register(fastifyStatic, { root: config.clientDist, prefix: "/" });
	}

	return app;
}
