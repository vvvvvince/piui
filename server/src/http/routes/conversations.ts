// spec/09-api.md §8 (conversations) and §9 (the per-conversation event stream).
import type {
	AbortResponse,
	CommandsResponse,
	ConversationDetail,
	ConversationStatsResponse,
	CreateConversationRequest,
	CreateConversationResponse,
	MessagesResponse,
	PatchConversationRequest,
	PostMessageRequest,
	PostMessageResponse,
	QueueResponse,
	UiResponseRequest,
} from "@piui/shared";
import type { CommandService } from "../../commands/service.js";
import type { ConversationService } from "../../conversations/service.js";
import type { SessionHub } from "../../session/hub.js";
import type { PiuiFastify } from "../auth.js";
import { openSse, SSE_PING_INTERVAL_MS } from "../sse.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export async function registerConversationRoutes(
	app: PiuiFastify,
	service: ConversationService,
	hub: SessionHub,
	commands: CommandService,
): Promise<void> {
	app.get<{ Querystring: { archived?: string; limit?: string } }>(
		"/api/conversations",
		async (req) => {
			const archived = req.query.archived;
			return {
				items: service.list(req.principal!, {
					...(archived === undefined ? {} : { archived: archived === "true" || archived === "1" }),
					...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
				}),
				nextCursor: null,
			};
		},
	);

	app.post<{ Body: CreateConversationRequest }>(
		"/api/conversations",
		{
			schema: {
				body: {
					type: "object",
					required: ["mode", "provider", "modelId"],
					additionalProperties: false,
					properties: {
						mode: { type: "string", enum: ["chat", "agent"] },
						provider: { type: "string", minLength: 1 },
						modelId: { type: "string", minLength: 1 },
						thinkingLevel: { type: "string", enum: THINKING_LEVELS },
						profileId: { type: "string" },
						workspaceId: { type: "string" },
						webSearch: { type: "boolean" },
						title: { type: "string" },
						timezone: { type: "string" },
						initialMessage: { type: "string" },
					},
				},
			},
		},
		async (req, reply): Promise<CreateConversationResponse> => {
			const result = await service.create(req.principal!, req.body);
			reply.status(201);
			return result;
		},
	);

	app.get<{ Params: { id: string } }>(
		"/api/conversations/:id",
		async (req): Promise<ConversationDetail> => await service.get(req.principal!, req.params.id),
	);

	app.get<{ Params: { id: string } }>(
		"/api/conversations/:id/messages",
		async (req): Promise<MessagesResponse> => service.messages(req.principal!, req.params.id),
	);

	app.patch<{ Params: { id: string }; Body: PatchConversationRequest }>(
		"/api/conversations/:id",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					properties: {
						title: { type: "string" },
						archived: { type: "boolean" },
						provider: { type: "string" },
						modelId: { type: "string" },
						thinkingLevel: { type: "string", enum: THINKING_LEVELS },
						webSearch: { type: "boolean" },
						// Accepted so the domain can answer `409 immutable_after_start` (spec/09-api.md §8).
						profileId: { type: "string" },
						workspaceId: { type: "string" },
					},
				},
			},
		},
		async (req): Promise<ConversationDetail> =>
			service.patch(req.principal!, req.params.id, req.body ?? {}),
	);

	app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (req, reply) => {
		service.delete(req.principal!, req.params.id);
		return reply.status(204).send();
	});

	app.post<{ Params: { id: string }; Body: PostMessageRequest }>(
		"/api/conversations/:id/messages",
		{
			schema: {
				body: {
					type: "object",
					required: ["text"],
					additionalProperties: false,
					properties: {
						text: { type: "string", minLength: 1 },
						streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
					},
				},
			},
		},
		async (req, reply): Promise<PostMessageResponse> => {
			const queuedAs = await service.prompt(
				req.principal!,
				req.params.id,
				req.body.text,
				req.body.streamingBehavior,
			);
			reply.status(202);
			return { accepted: true, queuedAs };
		},
	);

	app.post<{ Params: { id: string } }>(
		"/api/conversations/:id/abort",
		async (req): Promise<AbortResponse> => ({
			restored: await service.abort(req.principal!, req.params.id),
		}),
	);

	// spec/16-extensions.md §5 — answering an extension dialog. Any tab may answer; answering a
	// request that is already gone is a 200, not an error (the other tab was faster).
	app.post<{ Params: { id: string }; Body: UiResponseRequest }>(
		"/api/conversations/:id/ui-response",
		{
			schema: {
				body: {
					type: "object",
					required: ["requestId"],
					additionalProperties: false,
					properties: {
						requestId: { type: "string", minLength: 1 },
						value: { type: "string" },
						confirmed: { type: "boolean" },
						cancelled: { type: "boolean" },
					},
				},
			},
		},
		async (req): Promise<{ resolved: boolean }> => {
			service.rowFor(req.principal!, req.params.id);
			const { requestId, ...answer } = req.body;
			return { resolved: hub.channel(req.params.id).resolveUi(requestId, answer) };
		},
	);

	app.post<{ Params: { id: string } }>(
		"/api/conversations/:id/queue/clear",
		async (req): Promise<QueueResponse> => service.clearQueue(req.principal!, req.params.id),
	);

	app.get<{ Params: { id: string } }>(
		"/api/conversations/:id/stats",
		async (req): Promise<ConversationStatsResponse> => service.stats(req.principal!, req.params.id),
	);

	// spec/15-commands-and-input.md §1.1 — computed per conversation, never cached.
	app.get<{ Params: { id: string } }>(
		"/api/conversations/:id/commands",
		async (req): Promise<CommandsResponse> => ({
			items: commands.commandsFor(service.rowFor(req.principal!, req.params.id)),
		}),
	);

	// ------------------------------------------------------------------ SSE
	app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
		"/api/conversations/:id/events",
		async (req, reply) => {
			// Authorization first: an invisible conversation must 404 before the stream opens.
			await service.get(req.principal!, req.params.id);
			const live = await hub.ensure(req.params.id);

			const channel = openSse(req, reply);
			const lastEventId = req.headers["last-event-id"];
			const sinceRaw =
				req.query.since ?? (typeof lastEventId === "string" ? lastEventId : undefined);
			const since = Number(sinceRaw);
			const replay =
				sinceRaw !== undefined && Number.isFinite(since) ? live.replay(since) : undefined;

			if (replay) {
				for (const event of replay) channel.send(event, event.seq);
			} else {
				const snapshot = live.snapshot();
				channel.send(snapshot, snapshot.seq);
			}

			const unsubscribe = live.subscribe((event) => channel.send(event, event.seq));
			const ping = setInterval(
				() => channel.send({ type: "ping", seq: live.seq }),
				SSE_PING_INTERVAL_MS,
			);
			ping.unref?.();
			const stop = (): void => {
				clearInterval(ping);
				unsubscribe();
				channel.close();
			};
			req.raw.on("close", stop);
			reply.raw.on("close", stop);
		},
	);
}
