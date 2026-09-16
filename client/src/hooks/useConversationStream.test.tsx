// spec/10-frontend.md §3 — the normative event-application rules of the streaming hook.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent, emptyStreamState, useConversationStream } from "./useConversationStream.js";

const snapshot = {
	type: "snapshot" as const,
	seq: 5,
	messages: [
		{
			id: "m1",
			role: "user" as const,
			blocks: [{ type: "text" as const, id: "m1:0", text: "hi" }],
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	],
	state: {
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		queued: { steering: 0, followUp: 0 },
		contextPercent: null,
	},
};

describe("stream state reducer", () => {
	it("[10-frontend#3.1] replaces everything on a snapshot, whenever it arrives", () => {
		const dirty = applyEvent(emptyStreamState(), {
			type: "message_start",
			seq: 1,
			message: {
				id: "ghost",
				role: "assistant",
				blocks: [],
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		});
		const state = applyEvent(dirty, snapshot);
		expect(state.messages.map((m) => m.id)).toEqual(["m1"]);
		expect(state.lastSeq).toBe(5);
	});

	it("[10-frontend#3.1] appends block deltas and replaces blocks on block_end", () => {
		let state = applyEvent(emptyStreamState(), snapshot);
		state = applyEvent(state, {
			type: "message_start",
			seq: 6,
			message: {
				id: "m2",
				role: "assistant",
				blocks: [],
				createdAt: "2026-01-01T00:00:01.000Z",
				streaming: true,
			},
		});
		state = applyEvent(state, {
			type: "block_start",
			seq: 7,
			messageId: "m2",
			block: { type: "text", id: "m2:0", text: "" },
		});
		state = applyEvent(state, {
			type: "block_delta",
			seq: 8,
			messageId: "m2",
			blockId: "m2:0",
			textDelta: "Hel",
		});
		state = applyEvent(state, {
			type: "block_delta",
			seq: 9,
			messageId: "m2",
			blockId: "m2:0",
			textDelta: "lo",
		});
		const block = state.messages[1]!.blocks[0]!;
		expect(block.type === "text" && block.text).toBe("Hello");

		state = applyEvent(state, {
			type: "block_end",
			seq: 10,
			messageId: "m2",
			block: { type: "text", id: "m2:0", text: "Hello!" },
		});
		const ended = state.messages[1]!.blocks[0]!;
		expect(ended.type === "text" && ended.text).toBe("Hello!");
	});

	it("[10-frontend#3.1] dedupes replayed events by seq and tracks ancillary state", () => {
		let state = applyEvent(emptyStreamState(), snapshot);
		const stale = applyEvent(state, {
			type: "block_delta",
			seq: 3,
			messageId: "m1",
			blockId: "m1:0",
			textDelta: "REPLAYED",
		});
		expect(stale).toBe(state);

		state = applyEvent(state, {
			type: "queue",
			seq: 6,
			steering: ["a"],
			followUp: ["b", "c"],
		});
		expect(state.queue).toEqual({ steering: ["a"], followUp: ["b", "c"] });

		state = applyEvent(state, {
			type: "usage",
			seq: 7,
			tokensTotal: 10,
			costTotal: 0.5,
			contextPercent: 42,
		});
		expect(state.usage).toEqual({ tokensTotal: 10, costTotal: 0.5 });
		expect(state.state.contextPercent).toBe(42);

		state = applyEvent(state, { type: "title", seq: 8, title: "Named" });
		expect(state.title).toBe("Named");
	});

	it("[10-frontend#3.1] merges tool updates by block id", () => {
		let state = applyEvent(emptyStreamState(), {
			...snapshot,
			messages: [
				{
					id: "m1",
					role: "assistant" as const,
					blocks: [
						{
							type: "tool" as const,
							id: "m1:0",
							toolCallId: "t1",
							name: "write",
							label: "write",
							args: {},
							state: "running" as const,
						},
					],
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		state = applyEvent(state, {
			type: "tool_update",
			seq: 6,
			messageId: "m1",
			blockId: "m1:0",
			block: {
				type: "tool",
				id: "m1:0",
				toolCallId: "t1",
				name: "write",
				label: "write",
				args: {},
				state: "ok",
				output: "done",
			},
		});
		const block = state.messages[0]!.blocks[0]!;
		expect(block.type === "tool" && block.state).toBe("ok");
	});
});

class FakeEventSource {
	static last: FakeEventSource | undefined;
	onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onopen: (() => void) | null = null;
	closed = false;

	constructor(readonly url: string) {
		FakeEventSource.last = this;
	}

	close(): void {
		this.closed = true;
	}

	push(event: unknown): void {
		this.onmessage?.({ data: JSON.stringify(event) });
	}
}

describe("useConversationStream", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("[10-frontend#3.1] applies frames in a background tab, where requestAnimationFrame never fires", async () => {
		vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
		// A hidden tab gets no animation frames; the transcript must still advance.
		vi.stubGlobal("requestAnimationFrame", () => 1);
		const { result } = renderHook(() => useConversationStream("c-bg"));
		act(() => {
			FakeEventSource.last!.push(snapshot);
		});
		await waitFor(() => expect(result.current.messages).toHaveLength(1), { timeout: 2000 });
	});

	it("[10-frontend#3.1] applies live frames and reconnects with ?since=<lastSeq>", async () => {
		vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
		const { result } = renderHook(() => useConversationStream("c1"));
		const source = FakeEventSource.last!;
		expect(source.url).toBe("/api/conversations/c1/events");

		act(() => {
			source.onopen?.();
			source.push(snapshot);
		});
		await waitFor(() => expect(result.current.messages).toHaveLength(1));
		expect(result.current.connected).toBe(true);

		act(() => {
			source.onerror?.();
		});
		await waitFor(() => expect(result.current.connected).toBe(false));
	});
});
