// spec/10-frontend.md §3 — the streaming hook. The reducer is exported so its normative rules
// are testable without an EventSource.
import type { ConversationRuntimeState, UiBlock, UiEvent, UiMessage } from "@piui/shared";
import { useEffect, useMemo, useRef, useState } from "react";

export interface StreamState {
	messages: UiMessage[];
	state: ConversationRuntimeState;
	queue: { steering: string[]; followUp: string[] };
	usage: { tokensTotal: number; costTotal: number } | null;
	title: string | null;
	notices: { level: "info" | "warning" | "error"; text: string }[];
	lastSeq: number;
	doneCount: number;
}

export function emptyStreamState(): StreamState {
	return {
		messages: [],
		state: {
			isStreaming: false,
			isCompacting: false,
			isRetrying: false,
			queued: { steering: 0, followUp: 0 },
			contextPercent: null,
		},
		queue: { steering: [], followUp: [] },
		usage: null,
		title: null,
		notices: [],
		lastSeq: 0,
		doneCount: 0,
	};
}

const replaceMessage = (
	messages: UiMessage[],
	id: string,
	update: (message: UiMessage) => UiMessage,
): UiMessage[] => messages.map((message) => (message.id === id ? update(message) : message));

const replaceBlock = (message: UiMessage, block: UiBlock): UiMessage => ({
	...message,
	blocks: message.blocks.some((b) => b.id === block.id)
		? message.blocks.map((b) => (b.id === block.id ? block : b))
		: [...message.blocks, block],
});

/** Normative application rules (spec/10-frontend.md §3). Pure: state in, state out. */
export function applyEvent(state: StreamState, event: UiEvent): StreamState {
	// A snapshot is idempotent and valid at any time; everything else is deduped by seq.
	if (event.type !== "snapshot" && event.seq <= state.lastSeq) return state;
	const seq = Math.max(state.lastSeq, event.seq);

	switch (event.type) {
		case "snapshot":
			return {
				...state,
				messages: event.messages,
				state: event.state,
				lastSeq: event.seq,
			};
		case "state":
			return { ...state, state: event.state, lastSeq: seq };
		case "message_start":
			return {
				...state,
				messages: state.messages.some((m) => m.id === event.message.id)
					? replaceMessage(state.messages, event.message.id, () => event.message)
					: [...state.messages, event.message],
				lastSeq: seq,
			};
		case "block_start":
			return {
				...state,
				messages: replaceMessage(state.messages, event.messageId, (message) =>
					replaceBlock(message, event.block),
				),
				lastSeq: seq,
			};
		case "block_delta":
			return {
				...state,
				messages: replaceMessage(state.messages, event.messageId, (message) => ({
					...message,
					blocks: message.blocks.map((block) => {
						if (block.id !== event.blockId) return block;
						if ((block.type === "text" || block.type === "thinking") && event.textDelta) {
							return { ...block, text: block.text + event.textDelta };
						}
						if (block.type === "tool" && event.argsDelta) {
							return { ...block, argsText: (block.argsText ?? "") + event.argsDelta };
						}
						return block;
					}),
				})),
				lastSeq: seq,
			};
		case "block_end":
		case "tool_update":
			return {
				...state,
				messages: replaceMessage(state.messages, event.messageId, (message) =>
					replaceBlock(message, event.block),
				),
				lastSeq: seq,
			};
		case "message_end":
			return {
				...state,
				messages: state.messages.some((m) => m.id === event.message.id)
					? replaceMessage(state.messages, event.message.id, () => event.message)
					: [...state.messages, event.message],
				lastSeq: seq,
			};
		case "queue":
			return {
				...state,
				queue: { steering: event.steering, followUp: event.followUp },
				state: {
					...state.state,
					queued: { steering: event.steering.length, followUp: event.followUp.length },
				},
				lastSeq: seq,
			};
		case "usage":
			return {
				...state,
				usage: { tokensTotal: event.tokensTotal, costTotal: event.costTotal },
				state: { ...state.state, contextPercent: event.contextPercent },
				lastSeq: seq,
			};
		case "title":
			return { ...state, title: event.title, lastSeq: seq };
		case "notice":
			return {
				...state,
				notices: [...state.notices, { level: event.level, text: event.text }],
				lastSeq: seq,
			};
		case "done":
			return {
				...state,
				state: { ...state.state, isStreaming: false },
				doneCount: state.doneCount + 1,
				lastSeq: seq,
			};
		default:
			return { ...state, lastSeq: seq };
	}
}

export interface ConversationStream extends StreamState {
	connected: boolean;
}

const MAX_BACKOFF_MS = 10_000;

export function useConversationStream(conversationId: string | undefined): ConversationStream {
	const [stream, setStream] = useState<StreamState>(emptyStreamState);
	const [connected, setConnected] = useState(false);
	const lastSeqRef = useRef(0);
	const pending = useRef<UiEvent[]>([]);
	const frame = useRef<number | undefined>(undefined);

	useEffect(() => {
		lastSeqRef.current = stream.lastSeq;
	}, [stream.lastSeq]);

	useEffect(() => {
		if (!conversationId) return;
		let closed = false;
		let attempt = 0;
		let source: EventSource | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		// Deltas are applied in one batch per frame, never one render per token.
		const flush = (): void => {
			frame.current = undefined;
			const batch = pending.current;
			pending.current = [];
			if (batch.length === 0) return;
			setStream((current) => batch.reduce(applyEvent, current));
		};
		const schedule = (): void => {
			if (frame.current !== undefined) return;
			frame.current =
				typeof requestAnimationFrame === "function"
					? requestAnimationFrame(flush)
					: (setTimeout(flush, 30) as unknown as number);
		};

		const connect = (): void => {
			const since = lastSeqRef.current;
			const url =
				since > 0
					? `/api/conversations/${conversationId}/events?since=${since}`
					: `/api/conversations/${conversationId}/events`;
			source = new EventSource(url);
			source.onopen = () => {
				attempt = 0;
				setConnected(true);
			};
			source.onmessage = (event: MessageEvent<string>) => {
				try {
					pending.current.push(JSON.parse(event.data) as UiEvent);
					schedule();
				} catch {
					/* ignore an unparsable frame rather than tearing the transcript down */
				}
			};
			source.onerror = () => {
				setConnected(false);
				source?.close();
				if (closed) return;
				attempt += 1;
				const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
				retryTimer = setTimeout(connect, delay);
			};
		};
		connect();

		return () => {
			closed = true;
			if (retryTimer) clearTimeout(retryTimer);
			source?.close();
			setConnected(false);
		};
	}, [conversationId]);

	// A conversation switch starts from a clean slate.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the id changes
	useEffect(() => {
		setStream(emptyStreamState());
		lastSeqRef.current = 0;
	}, [conversationId]);

	return useMemo(() => ({ ...stream, connected }), [stream, connected]);
}
