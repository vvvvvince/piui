// spec/09-api.md §9 — GET /api/events, the global notification channel.
import type { Services } from "../../services.js";
import type { PiuiFastify } from "../auth.js";
import { openSse, SSE_PING_INTERVAL_MS } from "../sse.js";

export async function registerGlobalEventRoutes(
	app: PiuiFastify,
	services: Services,
): Promise<void> {
	app.get("/api/events", (req, reply) => {
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
