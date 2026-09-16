// SessionHub — one LiveSession per conversation, the SSE ring buffer, the run semaphore and
// idle eviction. spec/01-architecture.md §§4.4-4.5, spec/09-api.md §9.
import type { ConversationRuntimeState, UiEvent, UiMessage, UiRequest } from "@piui/shared";
import { ApiError } from "../http/errors.js";
import type { GlobalEventBus } from "./bus.js";
import { EventProjector, type ProjectedEvent } from "./event-map.js";
import { isAbortedMessage, MessageIds, type PiMessage, projectTranscript } from "./transcript.js";

export const RING_MAX_EVENTS = 2000;
export const RING_MAX_BYTES = 8 * 1024 * 1024;
export const EVICT_AFTER_MS = 15 * 60 * 1000;
const DELTA_TICK_MS = 50;

/** The slice of pi's AgentSession the hub needs; keeps the hub out of the pi boundary. */
export interface HubSession {
	readonly isStreaming: boolean;
	readonly isIdle: boolean;
	readonly isCompacting: boolean;
	readonly messages: readonly unknown[];
	readonly systemPrompt: string;
	readonly sessionFile: string | undefined;
	subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
	prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	abort(): Promise<void>;
	clearQueue(): { steering: string[]; followUp: string[] };
	// pi 0.85.1 exposes the queue as two getters, not the `getPendingMessages()` of spike S7.
	getSteeringMessages(): readonly string[];
	getFollowUpMessages(): readonly string[];
	waitForIdle(): Promise<void>;
	getSessionStats(): {
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		cost: number;
		contextUsage?: { tokens: number; contextWindow: number; percent: number };
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
	};
	dispose(): void;
}

export interface SessionHandle {
	session: HubSession;
	dispose(): void;
}

export type SessionFactory = (conversationId: string) => Promise<SessionHandle>;

export interface HubDeps {
	createSession: SessionFactory;
	events: GlobalEventBus;
	/** Domain clock (fake in tests) — drives eviction. */
	nowMs(): number;
	maxConcurrentRuns: number;
	/** spec/08-agent-mode.md §6 — runaway guards, no approval gates (decisions Q3/Q9). */
	maxRunMinutes: number;
	maxToolCallsPerRun: number;
	onRunEnd?(conversationId: string, session: HubSession): void;
}

/**
 * The per-conversation event conduit: sequence, ring buffer and subscribers. It deliberately
 * outlives the pi session, because changing the model or the web-search toggle **replaces**
 * the session (spec/07-chat-mode.md §3) and an attached SSE stream must keep working across
 * that swap — and `Last-Event-ID` must keep meaning the same thing.
 */
/** What a `ui-response` carries back (spec/16-extensions.md §5). */
export interface UiAnswer {
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

interface PendingUiRequest {
	request: UiRequest;
	resolve(answer: UiAnswer): void;
	timer?: NodeJS.Timeout;
}

export class ConversationChannel {
	private readonly ring: UiEvent[] = [];
	private ringBytes = 0;
	private readonly subscribers = new Set<(event: UiEvent) => void>();
	/**
	 * Extension dialogs waiting for an answer. They live on the **channel**, not the session:
	 * the channel outlives a session swap, which is what lets a pending dialog survive a reload
	 * and be answered from another tab (spec/16-extensions.md §5).
	 */
	private readonly pendingUi = new Map<string, PendingUiRequest>();
	seq = 0;

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	emit(projected: ProjectedEvent): UiEvent {
		this.seq += 1;
		const event = { ...projected, seq: this.seq } as UiEvent;
		this.ring.push(event);
		this.ringBytes += JSON.stringify(event).length;
		while (this.ring.length > RING_MAX_EVENTS || this.ringBytes > RING_MAX_BYTES) {
			const dropped = this.ring.shift();
			if (!dropped) break;
			this.ringBytes -= JSON.stringify(dropped).length;
		}
		for (const subscriber of [...this.subscribers]) subscriber(event);
		return event;
	}

	/** Frames after `since`, or undefined when the ring no longer covers it. */
	replay(since: number): UiEvent[] | undefined {
		if (since === this.seq) return [];
		// A `since` from the future belongs to a previous server process: send a snapshot.
		if (since > this.seq) return undefined;
		const first = this.ring[0];
		if (!first || since < first.seq - 1) return undefined;
		return this.ring.filter((event) => event.seq > since);
	}

	subscribe(listener: (event: UiEvent) => void): () => void {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	}

	// ---------------------------------------------- the extension UI bridge

	get pendingUiRequests(): UiRequest[] {
		return [...this.pendingUi.values()].map((entry) => entry.request);
	}

	/** Emits `ui_request` and resolves when a tab answers — or when the timeout expires. */
	ask(request: UiRequest): Promise<UiAnswer> {
		return new Promise<UiAnswer>((resolve) => {
			const entry: PendingUiRequest = { request, resolve };
			if (request.timeoutMs && request.timeoutMs > 0) {
				// spec §5: honour pi's timeout by auto-resolving "no answer" (undefined / false).
				entry.timer = setTimeout(
					() => this.resolveUi(request.requestId, { cancelled: true }),
					request.timeoutMs,
				);
				entry.timer.unref?.();
			}
			this.pendingUi.set(request.requestId, entry);
			this.emit({ type: "ui_request", ...request });
		});
	}

	/** True when the request existed; a second tab answering twice is a no-op, not a 404. */
	resolveUi(requestId: string, answer: UiAnswer): boolean {
		const entry = this.pendingUi.get(requestId);
		if (!entry) return false;
		this.pendingUi.delete(requestId);
		if (entry.timer) clearTimeout(entry.timer);
		entry.resolve(answer);
		this.emit({ type: "ui_request_resolved", requestId });
		return true;
	}

	/** The session went away: every waiting extension promise resolves as cancelled (§5). */
	cancelPendingUi(): void {
		for (const requestId of [...this.pendingUi.keys()]) {
			this.resolveUi(requestId, { cancelled: true });
		}
	}
}

export class LiveSession {
	readonly ids = new MessageIds();
	readonly projector: EventProjector;
	private readonly unsubscribe: () => void;
	private flushTimer: NodeJS.Timeout | undefined;
	private runTimer: NodeJS.Timeout | undefined;
	private toolCallsThisRun = 0;
	/** Typed `/command` texts whose expansion pi has not produced yet. */
	private readonly pendingTyped: string[] = [];
	/** Expanded text -> what the user typed, so a snapshot keeps the echo. */
	private readonly echoes = new Map<string, { typed: string; expandedChars: number }>();
	lastActivityMs: number;

	constructor(
		readonly conversationId: string,
		readonly handle: SessionHandle,
		private readonly deps: HubDeps,
		readonly channel: ConversationChannel = new ConversationChannel(),
	) {
		this.projector = new EventProjector({ ids: this.ids });
		this.lastActivityMs = deps.nowMs();
		this.unsubscribe = handle.session.subscribe((event) => this.ingest(event));
	}

	get seq(): number {
		return this.channel.seq;
	}

	get session(): HubSession {
		return this.handle.session;
	}

	get subscriberCount(): number {
		return this.channel.subscriberCount;
	}

	get state(): ConversationRuntimeState {
		const stats = safeStats(this.session);
		return {
			isStreaming: this.session.isStreaming,
			isCompacting: this.session.isCompacting,
			isRetrying: false,
			queued: {
				steering: this.session.getSteeringMessages().length,
				followUp: this.session.getFollowUpMessages().length,
			},
			contextPercent: contextPercentOf(stats),
		};
	}

	messages(): UiMessage[] {
		const messages = projectTranscript(this.session.messages, this.ids).map((message) =>
			this.withEcho(message),
		);
		const partial = this.projector.partial;
		if (partial && !messages.some((m) => m.id === partial.id)) messages.push(partial);
		return messages;
	}

	/**
	 * spec/15-commands-and-input.md §1.3 — the transcript renders the **typed** command with a
	 * "show expanded" disclosure. piui never expands anything itself: it remembers what was typed
	 * and compares it with the user message pi produced.
	 */
	noteTyped(text: string): void {
		if (text.startsWith("/")) this.pendingTyped.push(text);
	}

	private withEcho(message: UiMessage): UiMessage {
		if (message.role !== "user" || message.commandEcho) return message;
		const text = message.blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
		let echo = this.echoes.get(text);
		if (!echo && this.pendingTyped.length > 0) {
			const typed = this.pendingTyped.shift()!;
			if (typed !== text) {
				echo = { typed, expandedChars: text.length };
				this.echoes.set(text, echo);
			}
		}
		return echo ? { ...message, commandEcho: echo } : message;
	}

	snapshot(): UiEvent {
		const pendingUiRequests = this.channel.pendingUiRequests;
		return {
			type: "snapshot",
			seq: this.seq,
			messages: this.messages(),
			state: this.state,
			...(pendingUiRequests.length > 0 ? { pendingUiRequests } : {}),
		};
	}

	replay(since: number): UiEvent[] | undefined {
		return this.channel.replay(since);
	}

	subscribe(listener: (event: UiEvent) => void): () => void {
		const unsubscribe = this.channel.subscribe(listener);
		this.lastActivityMs = this.deps.nowMs();
		return () => {
			unsubscribe();
			this.lastActivityMs = this.deps.nowMs();
		};
	}

	emit(projected: ProjectedEvent): UiEvent {
		return this.channel.emit(projected);
	}

	private ingest(event: { type: string; [key: string]: unknown }): void {
		this.lastActivityMs = this.deps.nowMs();
		for (const projected of this.projector.ingest(event)) {
			const message = "message" in projected ? projected.message : undefined;
			this.emit(
				typeof message === "object" && message !== null
					? ({ ...projected, message: this.withEcho(message) } as ProjectedEvent)
					: projected,
			);
		}

		switch (event.type) {
			case "tool_execution_start":
				this.toolCallsThisRun += 1;
				if (this.toolCallsThisRun > this.deps.maxToolCallsPerRun) {
					this.tripGuard(
						`Stopped after ${this.deps.maxToolCallsPerRun} tool calls in one run (PIUI_MAX_TOOL_CALLS). ` +
							"Send another message to continue.",
					);
				}
				break;
			case "agent_start":
			case "turn_start":
				this.startRunTimer();
				this.startFlushTimer();
				this.emit({ type: "state", state: this.state });
				this.deps.events.emit({
					type: "conversation_state",
					conversationId: this.conversationId,
					isStreaming: true,
				});
				break;
			case "agent_end": {
				this.emitUsage();
				break;
			}
			case "agent_settled": {
				this.stopRunTimer();
				this.stopFlushTimer();
				for (const projected of this.projector.flush()) this.emit(projected);
				this.emitUsage();
				this.emit({ type: "state", state: this.state });
				this.emit({ type: "done", reason: lastRunReason(this.session) });
				this.deps.events.emit({
					type: "conversation_state",
					conversationId: this.conversationId,
					isStreaming: false,
				});
				this.deps.events.emit({ type: "conversation_done", conversationId: this.conversationId });
				this.deps.onRunEnd?.(this.conversationId, this.session);
				break;
			}
			case "queue_update":
				this.emit({ type: "state", state: this.state });
				break;
			default:
				break;
		}
	}

	private emitUsage(): void {
		const stats = safeStats(this.session);
		if (!stats) return;
		this.emit({
			type: "usage",
			tokensTotal: stats.tokens.total,
			costTotal: stats.cost,
			contextPercent: contextPercentOf(stats),
		});
	}

	/** A guard tripped: tell the user in the transcript, then stop the run. Never a gate. */
	private tripGuard(text: string): void {
		this.stopRunTimer();
		this.emit({ type: "notice", level: "warning", text });
		void this.session.abort().catch(() => {
			/* the run may have settled on its own in the meantime */
		});
	}

	private startRunTimer(): void {
		if (this.runTimer) return;
		this.toolCallsThisRun = 0;
		this.runTimer = setTimeout(
			() =>
				this.tripGuard(
					`Stopped after ${this.deps.maxRunMinutes} minutes (PIUI_MAX_RUN_MINUTES). ` +
						"Send another message to continue.",
				),
			Math.max(1, this.deps.maxRunMinutes * 60_000),
		);
		this.runTimer.unref?.();
	}

	private stopRunTimer(): void {
		if (!this.runTimer) return;
		clearTimeout(this.runTimer);
		this.runTimer = undefined;
	}

	private startFlushTimer(): void {
		if (this.flushTimer) return;
		this.flushTimer = setInterval(() => {
			for (const projected of this.projector.flush()) this.emit(projected);
		}, DELTA_TICK_MS);
		this.flushTimer.unref?.();
	}

	private stopFlushTimer(): void {
		if (!this.flushTimer) return;
		clearInterval(this.flushTimer);
		this.flushTimer = undefined;
	}

	/** Disposes the pi session only: the channel (and its SSE subscribers) survives. */
	dispose(): void {
		this.stopRunTimer();
		this.stopFlushTimer();
		this.channel.cancelPendingUi();
		this.unsubscribe();
		this.handle.dispose();
	}
}

export class SessionHub {
	private readonly sessions = new Map<string, LiveSession>();
	private readonly channels = new Map<string, ConversationChannel>();
	private readonly loading = new Map<string, Promise<LiveSession>>();
	private running = 0;

	constructor(private readonly deps: HubDeps) {}

	get liveCount(): number {
		return this.sessions.size;
	}

	peek(conversationId: string): LiveSession | undefined {
		return this.sessions.get(conversationId);
	}

	/** The conduit for a conversation, created on demand and kept across session swaps. */
	channel(conversationId: string): ConversationChannel {
		const existing = this.channels.get(conversationId);
		if (existing) return existing;
		const channel = new ConversationChannel();
		this.channels.set(conversationId, channel);
		return channel;
	}

	/** Emit into the conversation's channel whether or not a pi session is loaded. */
	notify(conversationId: string, event: ProjectedEvent): void {
		this.channel(conversationId).emit(event);
	}

	/** Lazily created on first prompt or first SSE attach (spec §4.5). */
	async ensure(conversationId: string): Promise<LiveSession> {
		const existing = this.sessions.get(conversationId);
		if (existing) return existing;
		const loading = this.loading.get(conversationId);
		if (loading) return loading;

		const promise = (async () => {
			const handle = await this.deps.createSession(conversationId);
			const live = new LiveSession(conversationId, handle, this.deps, this.channel(conversationId));
			this.sessions.set(conversationId, live);
			this.loading.delete(conversationId);
			return live;
		})();
		this.loading.set(conversationId, promise);
		try {
			return await promise;
		} catch (error) {
			this.loading.delete(conversationId);
			throw error;
		}
	}

	/** One run per conversation plus the global cap (spec/01-architecture.md §5). */
	async prompt(
		conversationId: string,
		text: string,
		streamingBehavior?: "steer" | "followUp",
	): Promise<"steer" | "followUp" | null> {
		const live = await this.ensure(conversationId);
		live.noteTyped(text);
		if (live.session.isStreaming) {
			if (!streamingBehavior) {
				throw new ApiError(
					"conversation_busy",
					"This conversation is still streaming; steer it or queue a follow-up.",
				);
			}
			await live.session.prompt(text, { streamingBehavior });
			return streamingBehavior;
		}
		if (this.running >= this.deps.maxConcurrentRuns) {
			throw new ApiError("too_many_runs", "Too many conversations are running at once.");
		}
		this.running += 1;
		// The route must not await the run: prompt() resolves when the run settles.
		void live.session
			.prompt(text)
			.catch(() => {
				/* errors reach the client as events */
			})
			.finally(() => {
				this.running = Math.max(0, this.running - 1);
			});
		return null;
	}

	async abort(conversationId: string): Promise<{ steering: string[]; followUp: string[] }> {
		const live = this.sessions.get(conversationId);
		if (!live) return { steering: [], followUp: [] };
		// Clear the queue first so the client can restore the text, then abort, then wait idle.
		const restored = live.session.clearQueue();
		await live.session.abort();
		await Promise.race([
			live.session.waitForIdle(),
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 5000);
				timer.unref?.();
			}),
		]);
		return restored;
	}

	/** Drops sessions with no subscriber that have been idle for 15 minutes. */
	evictIdle(): string[] {
		const evicted: string[] = [];
		for (const [id, live] of this.sessions) {
			if (live.subscriberCount > 0 || live.session.isStreaming) continue;
			if (this.deps.nowMs() - live.lastActivityMs < EVICT_AFTER_MS) continue;
			live.dispose();
			this.sessions.delete(id);
			evicted.push(id);
		}
		return evicted;
	}

	/** Drops the pi session; subscribers stay attached and see the next session's events. */
	drop(conversationId: string): void {
		const live = this.sessions.get(conversationId);
		if (!live) return;
		live.dispose();
		this.sessions.delete(conversationId);
	}

	/** Every session is stale (a prompt-template rescan): subscribers stay attached. */
	dropAll(): void {
		for (const id of [...this.sessions.keys()]) this.drop(id);
	}

	/** The conversation is gone: drop the session *and* its channel. */
	forget(conversationId: string): void {
		this.drop(conversationId);
		this.channels.delete(conversationId);
	}

	async disposeAll(): Promise<void> {
		for (const live of this.sessions.values()) {
			try {
				await live.session.abort();
			} catch {
				/* best effort */
			}
			live.dispose();
		}
		this.sessions.clear();
	}
}

function safeStats(session: HubSession): ReturnType<HubSession["getSessionStats"]> | undefined {
	try {
		return session.getSessionStats();
	} catch {
		return undefined;
	}
}

function contextPercentOf(
	stats: ReturnType<HubSession["getSessionStats"]> | undefined,
): number | null {
	// pi reports a fraction (0.03 = 3 %) — spike plan/spikes/05.
	const percent = stats?.contextUsage?.percent;
	if (typeof percent !== "number") return null;
	return Math.min(100, Math.max(0, Math.round(percent * 1000) / 10));
}

function lastRunReason(session: HubSession): "settled" | "aborted" | "error" {
	const messages = session.messages as PiMessage[];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (isAbortedMessage(message)) return "aborted";
		if (message.stopReason === "error") return "error";
		return "settled";
	}
	return "settled";
}
