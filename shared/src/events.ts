// SSE payload types. Source of truth: spec/02-data-model.md §§4-5.

export type UiBlock =
	| { type: "text"; id: string; text: string }
	| { type: "thinking"; id: string; text: string; collapsedByDefault: true }
	| {
			type: "tool";
			id: string;
			toolCallId: string;
			name: string;
			label: string;
			args: unknown;
			argsText?: string;
			state: "pending" | "running" | "ok" | "error";
			output?: string;
			outputTruncated?: boolean;
			details?: unknown;
			durationMs?: number;
	  };

export interface UiMessage {
	id: string;
	role: "user" | "assistant" | "system" | "bash" | "error";
	blocks: UiBlock[];
	/** Set when the text was produced by expanding a skill/template command (spec 15 §1.3). */
	commandEcho?: { typed: string; expandedChars: number };
	attachments?: { id: string; kind: "image"; mimeType: string; url: string }[];
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	model?: string;
	createdAt: string;
	streaming?: boolean;
}

export interface ConversationRuntimeState {
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	queued: { steering: number; followUp: number };
	contextPercent: number | null;
}

export type UiEvent =
	| { type: "snapshot"; seq: number; messages: UiMessage[]; state: ConversationRuntimeState }
	| { type: "state"; seq: number; state: ConversationRuntimeState }
	| { type: "message_start"; seq: number; message: UiMessage }
	| { type: "block_start"; seq: number; messageId: string; block: UiBlock }
	| {
			type: "block_delta";
			seq: number;
			messageId: string;
			blockId: string;
			textDelta?: string;
			argsDelta?: string;
	  }
	| { type: "block_end"; seq: number; messageId: string; block: UiBlock }
	| { type: "message_end"; seq: number; message: UiMessage }
	| { type: "tool_update"; seq: number; messageId: string; blockId: string; block: UiBlock }
	| { type: "queue"; seq: number; steering: string[]; followUp: string[] }
	| {
			type: "ui_request";
			seq: number;
			requestId: string;
			method: "select" | "confirm" | "input" | "editor";
			title?: string;
			message?: string;
			options?: string[];
			placeholder?: string;
			prefill?: string;
			timeoutMs?: number;
	  }
	| { type: "ui_request_resolved"; seq: number; requestId: string }
	| { type: "status"; seq: number; key: string; text: string | null }
	| {
			type: "widget";
			seq: number;
			key: string;
			lines: string[] | null;
			placement: "aboveEditor" | "belowEditor";
	  }
	| { type: "notice"; seq: number; level: "info" | "warning" | "error"; text: string }
	| {
			type: "usage";
			seq: number;
			tokensTotal: number;
			costTotal: number;
			contextPercent: number | null;
	  }
	| { type: "title"; seq: number; title: string }
	| { type: "done"; seq: number; reason: "settled" | "aborted" | "error" }
	| { type: "ping"; seq: number };
