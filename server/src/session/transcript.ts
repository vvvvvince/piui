// pi messages -> UiMessage[] (spec/02-data-model.md §4, spike plan/spikes/05).
// Deliberately structural: the projection layer must not import pi (grep-tested).
import { createHash } from "node:crypto";
import type { UiBlock, UiMessage } from "@piui/shared";

export const TOOL_OUTPUT_LIMIT = 16 * 1024;

export interface PiTextContent {
	type: "text";
	text: string;
}
export interface PiThinkingContent {
	type: "thinking";
	thinking: string;
}
export interface PiToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export type PiContent = PiTextContent | PiThinkingContent | PiToolCall | { type: string };

export interface PiMessage {
	role: string;
	content?: string | PiContent[];
	timestamp?: number;
	model?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: unknown };
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	[key: string]: unknown;
}

/** Stable UiMessage ids: the same pi message object always projects to the same id. */
export class MessageIds {
	private readonly ids = new WeakMap<object, string>();
	private n = 0;

	/** Needed to build upload URLs for image attachments (spec/09-api.md §10). */
	constructor(readonly conversationId: string = "") {}

	/** Pin a (new) message object to an id already handed out — pi swaps the object on end. */
	assign(message: object, id: string): void {
		this.ids.set(message, id);
	}

	idFor(message: object): string {
		const existing = this.ids.get(message);
		if (existing) return existing;
		this.n += 1;
		const id = `m${this.n}`;
		this.ids.set(message, id);
		return id;
	}
}

/**
 * spec/07-chat-mode.md §6.4 — images a user attached. The stored upload is named by the sha256
 * of its bytes, so the URL is recomputed here without any mapping table; an image that was
 * inlined as base64 instead (the small-image path) falls back to a data URL.
 */
export function imageAttachmentsOf(
	content: PiMessage["content"],
	conversationId: string,
): NonNullable<UiMessage["attachments"]> {
	if (!Array.isArray(content)) return [];
	const out: NonNullable<UiMessage["attachments"]> = [];
	for (const item of content) {
		if (item.type !== "image") continue;
		const image = item as unknown as { data: string; mimeType: string };
		const id = uploadIdOf(image.data, image.mimeType);
		out.push({
			id,
			kind: "image",
			mimeType: image.mimeType,
			url: conversationId
				? `/api/uploads/${conversationId}/${id}`
				: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return out;
}

/** The upload id is `sha256(bytes)[0..32].<ext>` — the same rule the upload service applies. */
export function uploadIdOf(base64: string, mimeType: string): string {
	const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.replace("image/", "");
	return `${createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex").slice(0, 32)}.${ext}`;
}

export function textOf(content: PiMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is PiTextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

export function truncateOutput(text: string): { output: string; outputTruncated?: boolean } {
	if (text.length <= TOOL_OUTPUT_LIMIT) return { output: text };
	return { output: `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n…[truncated]`, outputTruncated: true };
}

export const TOOL_DETAILS_LIMIT = 8 * 1024;

/**
 * Structured tool details reach the client (the Sources footer reads `web_search` results out
 * of them, spec/07-chat-mode.md §3). A tool is free to return anything, so anything too big to
 * belong in an SSE frame is dropped rather than truncated into invalid JSON.
 */
export function safeDetails(details: unknown): { details?: unknown } {
	if (details === undefined || details === null) return {};
	try {
		const encoded = JSON.stringify(details);
		if (encoded === undefined || encoded.length > TOOL_DETAILS_LIMIT) return {};
		return { details: JSON.parse(encoded) as unknown };
	} catch {
		return {};
	}
}

/**
 * A user-initiated stop is not an error. pi 0.85.1 ends the turn that follows an `abort()`
 * with `stopReason: "error"` and `errorMessage: "This operation was aborted"`, so both
 * projection paths route through here rather than painting a red error bubble the user caused
 * on purpose (spec/07-chat-mode.md §6.6, spec/08-agent-mode.md §4).
 */
export function isAbortedMessage(message: PiMessage): boolean {
	if (message.stopReason === "aborted") return true;
	return message.stopReason === "error" && /abort/i.test(message.errorMessage ?? "");
}

export function roleOfAssistant(message: PiMessage): "assistant" | "error" {
	return message.stopReason === "error" && !isAbortedMessage(message) ? "error" : "assistant";
}

export function costOf(usage: PiMessage["usage"]): number {
	const cost = (usage as { cost?: { total?: number } } | undefined)?.cost;
	return typeof cost?.total === "number" ? cost.total : 0;
}

export function blocksOfAssistant(message: PiMessage, messageId: string): UiBlock[] {
	const content = Array.isArray(message.content) ? message.content : [];
	const blocks: UiBlock[] = [];
	content.forEach((item, index) => {
		const id = `${messageId}:${index}`;
		if (item.type === "text") {
			blocks.push({ type: "text", id, text: (item as PiTextContent).text });
		} else if (item.type === "thinking") {
			blocks.push({
				type: "thinking",
				id,
				text: (item as PiThinkingContent).thinking,
				collapsedByDefault: true,
			});
		} else if (item.type === "toolCall") {
			const call = item as PiToolCall;
			blocks.push({
				type: "tool",
				id,
				toolCallId: call.id,
				name: call.name,
				label: call.name,
				args: call.arguments,
				state: "pending",
			});
		}
	});
	return blocks;
}

/**
 * Projects a pi message list. A tool result is merged into the `tool` block of the assistant
 * message that called it — never rendered as its own message.
 */
export function projectTranscript(messages: readonly unknown[], ids: MessageIds): UiMessage[] {
	const out: UiMessage[] = [];
	const toolBlocks = new Map<string, Extract<UiBlock, { type: "tool" }>>();

	for (const raw of messages) {
		const message = raw as PiMessage;
		const id = ids.idFor(raw as object);
		const createdAt = new Date(message.timestamp ?? Date.now()).toISOString();

		if (message.role === "user") {
			const attachments = imageAttachmentsOf(message.content, ids.conversationId);
			out.push({
				id,
				role: "user",
				blocks: [{ type: "text", id: `${id}:0`, text: textOf(message.content) }],
				...(attachments.length > 0 ? { attachments } : {}),
				createdAt,
			});
			continue;
		}
		if (message.role === "toolResult") {
			const block = toolBlocks.get(String(message.toolCallId));
			if (!block) continue;
			const text = textOf(message.content);
			Object.assign(block, {
				state: message.isError ? "error" : "ok",
				...truncateOutput(text),
				...safeDetails(message.details),
			});
			continue;
		}
		// pi replaces the whole history with this one message plus the kept tail after a
		// compaction (spike plan/spikes/13 §2 fact 5). Without it the transcript would look
		// silently truncated.
		if (message.role === "compactionSummary") {
			out.push({
				id,
				role: "system",
				blocks: [
					{
						type: "text",
						id: `${id}:0`,
						text: `Context compacted. Summary of the earlier conversation:\n\n${String(
							message.summary ?? "",
						)}`,
					},
				],
				createdAt,
			});
			continue;
		}
		if (message.role !== "assistant") {
			// `bash` and custom messages: the type exists, V1 skips them (spec §4).
			continue;
		}

		const blocks = blocksOfAssistant(message, id);
		for (const block of blocks) {
			if (block.type === "tool") toolBlocks.set(block.toolCallId, block);
		}
		const usage = message.usage;
		const aborted = isAbortedMessage(message);
		const projected: UiMessage = {
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
			createdAt,
		};
		if (message.stopReason === "error" && !aborted && message.errorMessage && blocks.length > 0) {
			projected.blocks = [
				...blocks,
				{ type: "text", id: `${id}:error`, text: message.errorMessage },
			];
		}
		out.push(projected);
	}
	return out;
}
