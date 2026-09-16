import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { HealthResponse, MetaResponse } from "@piui/shared";
import Fastify from "fastify";
import type { AppContext } from "../context.js";
import { ForbiddenError, NotFoundError } from "../db/repositories/base.js";
import { createServices, type Services } from "../services.js";
import { LoginRateLimiter, registerAuth } from "./auth.js";
import { ApiError } from "./errors.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerGlobalEventRoutes } from "./routes/events.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";

declare module "fastify" {
	interface FastifyInstance {
		/** Process-wide services (pi runtime, credentials, models, hub). */
		piui: Services;
	}
}

export type PiuiServer = Awaited<ReturnType<typeof buildServer>>;

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

	const loginLimiter = new LoginRateLimiter(() => ctx.clock.nowMs());
	await registerAuth(app, { ctx, provider: ctx.authProvider, limiter: loginLimiter });

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
		req.log.error({ err: error }, "unhandled error");
		reply
			.status(error.statusCode ?? 500)
			.send(new ApiError("internal_error", "Something went wrong on the server.").toBody());
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
	await registerWorkspaceRoutes(app, services.workspaces);
	await registerConversationRoutes(app, services.conversations, services.hub);

	if (ctx.serveClient && existsSync(join(config.clientDist, "index.html"))) {
		await app.register(fastifyStatic, { root: config.clientDist, prefix: "/" });
	}

	return app;
}
