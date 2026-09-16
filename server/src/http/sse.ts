// SSE plumbing shared by the conversation stream and the global channel (spec/09-api.md §9).
import type { FastifyReply, FastifyRequest } from "fastify";

export const SSE_PING_INTERVAL_MS = 20_000;

export interface SseChannel {
	send(data: unknown, id?: number): void;
	comment(text: string): void;
	close(): void;
	readonly closed: boolean;
}

export function openSse(req: FastifyRequest, reply: FastifyReply): SseChannel {
	// Take the socket away from Fastify: the handler writes frames for the life of the request.
	reply.hijack();
	reply.raw.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	// Flush headers immediately so a proxy (and light-my-request) sees the stream start.
	reply.raw.write(": open\n\n");

	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		try {
			reply.raw.end();
		} catch {
			/* the socket is already gone */
		}
	};
	req.raw.on("close", () => {
		closed = true;
	});

	return {
		send(data: unknown, id?: number) {
			if (closed) return;
			const head = id === undefined ? "" : `id: ${id}\n`;
			reply.raw.write(`${head}event: message\ndata: ${JSON.stringify(data)}\n\n`);
		},
		comment(text: string) {
			if (closed) return;
			reply.raw.write(`: ${text}\n\n`);
		},
		close,
		get closed() {
			return closed;
		},
	};
}
