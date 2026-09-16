// spec/01-architecture.md §§4.4-4.5 and §5 — ring buffer, eviction, the run semaphore.
import type { UiEvent } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { GlobalEventBus } from "../../src/session/bus.js";
import { EVICT_AFTER_MS, type HubSession, SessionHub } from "../../src/session/hub.js";
import { FakeClock } from "../../src/util/clock.js";

function fakeSession(): HubSession & { emit(event: object): void; disposed: boolean } {
	const listeners = new Set<(event: { type: string; [k: string]: unknown }) => void>();
	let streaming = false;
	return {
		disposed: false,
		get isStreaming() {
			return streaming;
		},
		get isIdle() {
			return !streaming;
		},
		isCompacting: false,
		messages: [],
		systemPrompt: "test",
		sessionFile: undefined,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt() {
			streaming = true;
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			streaming = false;
		},
		async abort() {
			streaming = false;
		},
		clearQueue: () => ({ steering: [], followUp: [] }),
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		waitForIdle: async () => {},
		getSessionStats: () => ({
			tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
			cost: 0.01,
			contextUsage: { tokens: 30, contextWindow: 1000, percent: 0.03 },
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
		}),
		dispose() {
			this.disposed = true;
		},
		emit(event: object) {
			for (const listener of listeners) {
				listener(event as { type: string });
			}
		},
	};
}

function makeHub(clock = new FakeClock(), maxConcurrentRuns = 4) {
	const sessions = new Map<string, ReturnType<typeof fakeSession>>();
	const hub = new SessionHub({
		createSession: async (id) => {
			const session = fakeSession();
			sessions.set(id, session);
			return { session, dispose: () => session.dispose() };
		},
		events: new GlobalEventBus(),
		nowMs: () => clock.nowMs(),
		maxConcurrentRuns,
		maxRunMinutes: 30,
		maxToolCallsPerRun: 200,
	});
	return { hub, clock, sessions };
}

describe("session hub", () => {
	it("[01-architecture#4.5] creates a LiveSession lazily and evicts it after 15 idle minutes", async () => {
		const { hub, clock } = makeHub();
		expect(hub.peek("c1")).toBeUndefined();
		const live = await hub.ensure("c1");
		expect(hub.liveCount).toBe(1);

		const unsubscribe = live.subscribe(() => {});
		clock.advance(EVICT_AFTER_MS + 1);
		expect(hub.evictIdle()).toEqual([]); // a subscriber is attached
		unsubscribe();
		expect(hub.evictIdle()).toEqual([]); // the unsubscribe refreshed the activity stamp
		clock.advance(EVICT_AFTER_MS + 1);
		expect(hub.evictIdle()).toEqual(["c1"]);
		expect(hub.liveCount).toBe(0);
	});

	it("[01-architecture#4.4] stamps strictly increasing seq numbers and replays from the ring", async () => {
		const { hub } = makeHub();
		const live = await hub.ensure("c1");
		const seen: UiEvent[] = [];
		live.subscribe((event) => seen.push(event));

		for (let i = 0; i < 5; i += 1) live.emit({ type: "notice", level: "info", text: `n${i}` });
		expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(live.replay(3)?.map((e) => e.seq)).toEqual([4, 5]);
		expect(live.replay(5)).toEqual([]);
		// a cursor from a previous process must fall back to a snapshot
		expect(live.replay(900)).toBeUndefined();
		expect(live.snapshot().type).toBe("snapshot");
	});

	it("[01-architecture#5.1] refuses a concurrent prompt and caps the number of running sessions", async () => {
		const { hub } = makeHub(new FakeClock(), 1);
		await hub.prompt("c1", "hello");
		await expect(hub.prompt("c2", "hello")).rejects.toMatchObject({ code: "too_many_runs" });

		const live = hub.peek("c1")!;
		expect(live.session.isStreaming).toBe(true);
		await expect(hub.prompt("c1", "again")).rejects.toMatchObject({ code: "conversation_busy" });
		expect(await hub.prompt("c1", "again", "followUp")).toBe("followUp");
	});

	it("[01-architecture#4.4] reports context usage as a percentage, not pi's fraction", async () => {
		const { hub } = makeHub();
		const live = await hub.ensure("c1");
		expect(live.state.contextPercent).toBe(3);
	});
});
