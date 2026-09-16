// AgentSessionEvent -> UiEvent[] (spec/02-data-model.md §5, spike plan/spikes/04).
// Structural input types on purpose: nothing outside server/src/pi may import pi.
import type { UiBlock, UiEvent, UiMessage } from "@piui/shared";
import {
	blocksOfAssistant,
	costOf,
	imageAttachmentsOf,
	isAbortedMessage,
	type MessageIds,
	type PiMessage,
	roleOfAssistant,
	safeDetails,
	truncateOutput,
} from "./transcript.js";

type WithoutSeq<T> = T extends { seq: number } ? Omit<T, "seq"> : never;
/** A UiEvent before the hub stamps it with a sequence number. */
export type ProjectedEvent = WithoutSeq<UiEvent>;

export const DELTA_FLUSH_MS = 50;
export const DELTA_FLUSH_BYTES = 1024;

export interface PiSessionEvent {
	type: string;
	[key: string]: unknown;
}

interface DeltaBuffer {
	messageId: string;
	blockId: string;
	text: string;
	args: string;
	lastFlush: number;
}

export interface ProjectorDeps {
	ids: MessageIds;
	/** Real wall clock: delta coalescing is a rendering concern, not domain time. */
	now?(): number;
}

/**
 * Stateful per conversation. `ingest` returns the events to broadcast; `flush` exists so a
 * timer can push buffered deltas when the model goes quiet mid-block.
 */
export class EventProjector {
	private readonly ids: MessageIds;
	private readonly now: () => number;
	/** contentIndex -> block, for the assistant message currently streaming. */
	private blocks = new Map<number, UiBlock>();
	private buffers = new Map<number, DeltaBuffer>();
	private current: UiMessage | undefined;
	private readonly toolBlocks = new Map<string, { messageId: string; block: UiBlock }>();

	constructor(deps: ProjectorDeps) {
		this.ids = deps.ids;
		this.now = deps.now ?? Date.now;
	}

	/** The partially streamed assistant message, for snapshots taken mid-run. */
	get partial(): UiMessage | undefined {
		return this.current;
	}

	ingest(event: PiSessionEvent): ProjectedEvent[] {
		switch (event.type) {
			case "message_start":
				return this.onMessageStart(event.message as PiMessage);
			case "message_update":
				return this.onMessageUpdate(event);
			case "message_end":
				return this.onMessageEnd(event.message as PiMessage);
			case "tool_execution_start":
				return this.onToolState(String(event.toolCallId), "running");
			case "tool_execution_update":
				// §B.3: a tool may stream progress, so the card says "searching…" not "frozen".
				return this.onToolProgress(event);
			case "tool_execution_end":
				return this.onToolEnd(event);
			case "queue_update":
				return [
					{
						type: "queue",
						steering: [...((event.steering as string[]) ?? [])],
						followUp: [...((event.followUp as string[]) ?? [])],
					},
				];
			case "auto_retry_start":
				return [
					{
						type: "notice",
						level: "warning",
						text: `Retrying after an error (attempt ${String(event.attempt)}/${String(event.maxAttempts)}).`,
					},
				];
			case "thinking_level_changed":
				return [{ type: "notice", level: "info", text: `Thinking level: ${String(event.level)}` }];
			default:
				return [];
		}
	}

	/** Flush any buffered delta (called by the hub's timer and before a snapshot). */
	flush(): ProjectedEvent[] {
		const out: ProjectedEvent[] = [];
		for (const [index, buffer] of this.buffers) {
			const event = this.drain(index, buffer);
			if (event) out.push(event);
		}
		return out;
	}

	private onMessageStart(message: PiMessage): ProjectedEvent[] {
		const id = this.ids.idFor(message as object);
		if (message.role === "assistant") {
			this.blocks = new Map();
			this.buffers = new Map();

			this.current = {
				id,
				role: "assistant",
				blocks: [],
				createdAt: new Date(message.timestamp ?? this.now()).toISOString(),
				streaming: true,
				...(message.model ? { model: message.model } : {}),
			};
			return [{ type: "message_start", message: snapMessage(this.current) }];
		}
		if (message.role === "user") {
			return [
				{
					type: "message_start",
					message: {
						id,
						role: "user",
						blocks: [
							{
								type: "text",
								id: `${id}:0`,
								text:
									typeof message.content === "string" ? message.content : textOfContent(message),
							},
						],
						// spec/07-chat-mode.md §6.4 — the live frame must carry the images too, or the
						// bubble only shows them after a reload (found in the browser).
						...this.attachments(message),
						createdAt: new Date(message.timestamp ?? this.now()).toISOString(),
					},
				},
			];
		}
		return [];
	}

	private onMessageUpdate(event: PiSessionEvent): ProjectedEvent[] {
		const inner = event.assistantMessageEvent as
			| {
					type: string;
					contentIndex?: number;
					delta?: string;
					content?: string;
					toolCall?: unknown;
			  }
			| undefined;
		if (!inner || !this.current) return [];
		const messageId = this.current.id;
		const index = inner.contentIndex ?? 0;
		const blockId = `${messageId}:${index}`;

		switch (inner.type) {
			case "text_start":
			case "thinking_start": {
				const block: UiBlock =
					inner.type === "text_start"
						? { type: "text", id: blockId, text: "" }
						: { type: "thinking", id: blockId, text: "", collapsedByDefault: true };
				this.blocks.set(index, block);
				this.current.blocks = [...this.blocks.values()];
				this.buffers.set(index, {
					messageId,
					blockId,
					text: "",
					args: "",
					lastFlush: this.now(),
				});
				return [{ type: "block_start", messageId, block: snap(block) }];
			}
			case "text_delta":
			case "thinking_delta": {
				const block = this.blocks.get(index);
				const buffer = this.buffers.get(index);
				if (!block || !buffer || (block.type !== "text" && block.type !== "thinking")) return [];
				const delta = inner.delta ?? "";
				block.text += delta;
				buffer.text += delta;
				const event = this.maybeDrain(index, buffer);
				return event ? [event] : [];
			}
			case "text_end":
			case "thinking_end": {
				const block = this.blocks.get(index);
				if (!block) return [];
				const out: ProjectedEvent[] = [];
				const buffer = this.buffers.get(index);
				if (buffer) {
					const drained = this.drain(index, buffer);
					if (drained) out.push(drained);
				}
				if (block.type === "text" || block.type === "thinking") {
					block.text = inner.content ?? block.text;
				}
				out.push({ type: "block_end", messageId, block: snap(block) });
				return out;
			}
			case "toolcall_start": {
				const block: UiBlock = {
					type: "tool",
					id: blockId,
					toolCallId: "",
					name: "",
					label: "",
					args: {},
					argsText: "",
					state: "pending",
				};
				this.blocks.set(index, block);
				this.current.blocks = [...this.blocks.values()];
				this.buffers.set(index, { messageId, blockId, text: "", args: "", lastFlush: this.now() });
				return [{ type: "block_start", messageId, block: snap(block) }];
			}
			case "toolcall_delta": {
				const block = this.blocks.get(index);
				const buffer = this.buffers.get(index);
				if (block?.type !== "tool" || !buffer) return [];
				block.argsText = (block.argsText ?? "") + (inner.delta ?? "");
				buffer.args += inner.delta ?? "";
				const event = this.maybeDrain(index, buffer);
				return event ? [event] : [];
			}
			case "toolcall_end": {
				const block = this.blocks.get(index);
				if (block?.type !== "tool") return [];
				const call = inner.toolCall as
					| { id: string; name: string; arguments: Record<string, unknown> }
					| undefined;
				const out: ProjectedEvent[] = [];
				const buffer = this.buffers.get(index);
				if (buffer) {
					const drained = this.drain(index, buffer);
					if (drained) out.push(drained);
				}
				if (call) {
					block.toolCallId = call.id;
					block.name = call.name;
					block.label = call.name;
					block.args = call.arguments;
					this.toolBlocks.set(call.id, { messageId, block });
				}
				out.push({ type: "block_end", messageId, block: snap(block) });
				return out;
			}
			default:
				return [];
		}
	}

	/** Image attachments of a user message, keyed like the transcript projection. */
	private attachments(message: PiMessage): { attachments?: UiMessage["attachments"] } {
		const attachments = imageAttachmentsOf(message.content, this.ids.conversationId);
		return attachments.length > 0 ? { attachments } : {};
	}

	private onMessageEnd(message: PiMessage): ProjectedEvent[] {
		const out: ProjectedEvent[] = this.flush();
		this.buffers.clear();
		if (message.role !== "assistant") {
			if (message.role === "user") {
				const id = this.ids.idFor(message as object);
				out.push({
					type: "message_end",
					message: {
						id,
						role: "user",
						blocks: [{ type: "text", id: `${id}:0`, text: textOfContent(message) }],
						...this.attachments(message),
						createdAt: new Date(message.timestamp ?? this.now()).toISOString(),
					},
				});
			}
			return out;
		}

		// pi hands `message_end` a different object than `message_start` for the same message:
		// keep the streamed id so the client replaces the bubble instead of appending a second.
		const id = this.current?.id ?? this.ids.idFor(message as object);
		this.ids.assign(message as object, id);
		const blocks = blocksOfAssistant(message, id);
		// keep any tool result already merged into the streamed block
		for (const block of blocks) {
			if (block.type !== "tool") continue;
			const known = this.toolBlocks.get(block.toolCallId)?.block;
			if (known && known.type === "tool") {
				block.state = known.state;
				if (known.output !== undefined) block.output = known.output;
				if (known.outputTruncated) block.outputTruncated = true;
			}
			this.toolBlocks.set(block.toolCallId, { messageId: id, block });
		}
		const usage = message.usage;
		const aborted = isAbortedMessage(message);
		const finished: UiMessage = {
			id,
			role: roleOfAssistant(message),
			blocks:
				message.stopReason === "error" && !aborted && blocks.length === 0
					? [
							{
								type: "text",
								id: `${id}:0`,
								text: message.errorMessage ?? "The model returned an error.",
							},
						]
					: blocks,
			...(usage
				? {
						usage: {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							cost: costOf(usage),
						},
					}
				: {}),
			...(message.model ? { model: message.model } : {}),
			...(aborted ? { stopped: true as const } : {}),
			createdAt: new Date(message.timestamp ?? this.now()).toISOString(),
		};
		this.current = undefined;

		this.blocks = new Map();
		out.push({ type: "message_end", message: snapMessage(finished) });
		return out;
	}

	private onToolState(toolCallId: string, state: "running"): ProjectedEvent[] {
		const entry = this.toolBlocks.get(toolCallId);
		if (entry?.block.type !== "tool") return [];
		entry.block.state = state;
		return [
			{
				type: "tool_update",
				messageId: entry.messageId,
				blockId: entry.block.id,
				block: snap(entry.block),
			},
		];
	}

	private onToolProgress(event: PiSessionEvent): ProjectedEvent[] {
		const entry = this.toolBlocks.get(String(event.toolCallId));
		if (entry?.block.type !== "tool") return [];
		const partial = event.partialResult as
			| { content?: { type: string; text?: string }[]; details?: unknown }
			| undefined;
		const text = (partial?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		Object.assign(entry.block, {
			state: "running",
			...truncateOutput(text),
			...safeDetails(partial?.details),
		});
		return [
			{
				type: "tool_update",
				messageId: entry.messageId,
				blockId: entry.block.id,
				block: snap(entry.block),
			},
		];
	}

	private onToolEnd(event: PiSessionEvent): ProjectedEvent[] {
		const entry = this.toolBlocks.get(String(event.toolCallId));
		if (entry?.block.type !== "tool") return [];
		const result = event.result as
			| { content?: { type: string; text?: string }[]; details?: unknown }
			| undefined;
		const text = (result?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		Object.assign(entry.block, {
			state: event.isError ? "error" : "ok",
			...truncateOutput(text),
			...safeDetails(result?.details),
		});
		return [
			{
				type: "tool_update",
				messageId: entry.messageId,
				blockId: entry.block.id,
				block: snap(entry.block),
			},
		];
	}

	private maybeDrain(index: number, buffer: DeltaBuffer): ProjectedEvent | undefined {
		const size = buffer.text.length + buffer.args.length;
		if (size === 0) return undefined;
		if (size < DELTA_FLUSH_BYTES && this.now() - buffer.lastFlush < DELTA_FLUSH_MS)
			return undefined;
		return this.drain(index, buffer);
	}

	private drain(_index: number, buffer: DeltaBuffer): ProjectedEvent | undefined {
		if (buffer.text.length === 0 && buffer.args.length === 0) return undefined;
		const event: ProjectedEvent = {
			type: "block_delta",
			messageId: buffer.messageId,
			blockId: buffer.blockId,
			...(buffer.text ? { textDelta: buffer.text } : {}),
			...(buffer.args ? { argsDelta: buffer.args } : {}),
		};
		buffer.text = "";
		buffer.args = "";
		buffer.lastFlush = this.now();
		return event;
	}
}

/** Frames must be immutable: the projector keeps mutating its own block objects. */
function snap(block: UiBlock): UiBlock {
	return { ...block } as UiBlock;
}

function snapMessage(message: UiMessage): UiMessage {
	return { ...message, blocks: message.blocks.map(snap) };
}

function textOfContent(message: PiMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("");
}
