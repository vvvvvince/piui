// SSE harness — spec/20-development-method.md §3.5.
// Consumes a Fastify inject() streaming response (or any ReadableStream / async iterable of
// chunks), exposing frames with their `id:` so replay and dedupe can be asserted.

export interface SseFrame {
	id?: string;
	event?: string;
	data: string;
	json<T = unknown>(): T;
}

export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
	const frames: SseFrame[] = [];
	let rest = buffer;
	while (true) {
		const index = rest.indexOf("\n\n");
		if (index === -1) break;
		const raw = rest.slice(0, index);
		rest = rest.slice(index + 2);
		const frame = parseFrame(raw);
		if (frame) frames.push(frame);
	}
	return { frames, rest };
}

function parseFrame(raw: string): SseFrame | undefined {
	let id: string | undefined;
	let event: string | undefined;
	const data: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("id:")) id = line.slice(3).trim();
		else if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	if (data.length === 0 && id === undefined && event === undefined) return undefined;
	const payload = data.join("\n");
	return {
		...(id === undefined ? {} : { id }),
		...(event === undefined ? {} : { event }),
		data: payload,
		json<T>() {
			return JSON.parse(payload) as T;
		},
	};
}

export interface SseCollector {
	frames: SseFrame[];
	/** Resolves once `predicate` holds, or rejects after `timeoutMs` of no progress. */
	waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<SseFrame[]>;
	stop(): void;
	done: Promise<void>;
}

type ChunkSource = AsyncIterable<Uint8Array | string> | NodeJS.ReadableStream;

export function collectSse(source: ChunkSource): SseCollector {
	const frames: SseFrame[] = [];
	const waiters: { predicate: (frames: SseFrame[]) => boolean; resolve: () => void }[] = [];
	let stopped = false;
	const decoder = new TextDecoder();
	let buffer = "";

	const pump = async (): Promise<void> => {
		for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
			if (stopped) break;
			buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			const parsed = parseSseChunk(buffer);
			buffer = parsed.rest;
			frames.push(...parsed.frames);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i]!.predicate(frames)) {
					waiters[i]!.resolve();
					waiters.splice(i, 1);
				}
			}
		}
	};

	const done = pump();

	return {
		frames,
		waitFor(predicate, timeoutMs = 2000) {
			if (predicate(frames)) return Promise.resolve(frames);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(
							`SSE harness: predicate not satisfied within ${timeoutMs}ms; got ${frames.length} frames: ` +
								frames.map((f) => f.data.slice(0, 60)).join(" | "),
						),
					);
				}, timeoutMs);
				waiters.push({
					predicate,
					resolve: () => {
						clearTimeout(timer);
						resolve(frames);
					},
				});
			});
		},
		stop() {
			stopped = true;
		},
		done,
	};
}
