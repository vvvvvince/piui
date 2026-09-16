// spec/09-api.md §9 — GET /api/events, the global notification channel.
import type { Services } from "../../services.js";
import type { PiuiFastify } from "../auth.js";
import { ApiError } from "../errors.js";
import { MAX_GLOBAL_SUBSCRIBERS, openSse, SSE_PING_INTERVAL_MS } from "../sse.js";

export async function registerGlobalEventRoutes(
	app: PiuiFastify,
	services: Services,
): Promise<void> {
	app.get("/api/events", (req, reply) => {
		if (services.events.subscriberCount >= MAX_GLOBAL_SUBSCRIBERS) {
			throw new ApiError(
				"rate_limited",
				"Too many open event streams on this server; close a tab and try again.",
			);
		}
		const channel = openSse(req, reply);
		const unsubscribe = services.events.subscribe((event) => channel.send(event));
		const ping = setInterval(() => {
			if (channel.closed) return;
			channel.send({ type: "ping" });
		}, SSE_PING_INTERVAL_MS);
		ping.unref?.();

		const stop = (): void => {
			clearInterval(ping);
			unsubscribe();
			channel.close();
		};
		req.raw.on("close", stop);
		reply.raw.on("close", stop);
	});
}
