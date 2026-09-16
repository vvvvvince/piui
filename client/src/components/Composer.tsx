// The composer with pi TUI input semantics (spec/15-commands-and-input.md §4, normative).
import { useCallback, useEffect, useRef, useState } from "react";

export interface ComposerHandlers {
	onSend(text: string): unknown;
	onSteer(text: string): unknown;
	onFollowUp(text: string): unknown;
	/** Aborts the run; resolves with the queued text to restore in the composer. */
	onAbort(): Promise<string>;
	/** Clears the queue without aborting; resolves with the dequeued text. */
	onDequeue(): Promise<string>;
}

export interface ComposerProps {
	streaming: boolean;
	handlers: ComposerHandlers;
	conversationId: string;
	disabled?: boolean;
	disabledReason?: string;
	/** Rendered next to the hint row (globe toggle, model chip, …). */
	children?: React.ReactNode;
}

const HISTORY_LIMIT = 100;
const historyKey = (conversationId: string): string => `piui.v1.history.${conversationId}`;

function readHistory(conversationId: string): string[] {
	try {
		const raw = window.localStorage.getItem(historyKey(conversationId));
		return raw ? (JSON.parse(raw) as string[]) : [];
	} catch {
		return [];
	}
}

function pushHistory(conversationId: string, text: string): void {
	try {
		const next = [...readHistory(conversationId).filter((t) => t !== text), text].slice(
			-HISTORY_LIMIT,
		);
		window.localStorage.setItem(historyKey(conversationId), JSON.stringify(next));
	} catch {
		/* private mode: history is a nicety */
	}
}

const appendBelow = (current: string, restored: string): string => {
	if (!restored) return current;
	return current.trim().length > 0 ? `${current}\n\n${restored}` : restored;
};

export function Composer({
	streaming,
	handlers,
	conversationId,
	disabled,
	disabledReason,
	children,
}: ComposerProps): JSX.Element {
	const [text, setText] = useState("");
	const [historyIndex, setHistoryIndex] = useState<number | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on conversation switch
	useEffect(() => {
		setText("");
		setHistoryIndex(null);
	}, [conversationId]);

	const submit = useCallback(
		(mode: "send" | "steer" | "followUp") => {
			const value = text.trim();
			if (value.length === 0) return;
			pushHistory(conversationId, value);
			setText("");
			setHistoryIndex(null);
			if (mode === "send") handlers.onSend(value);
			else if (mode === "steer") handlers.onSteer(value);
			else handlers.onFollowUp(value);
		},
		[text, conversationId, handlers],
	);

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
		const area = event.currentTarget;
		if (event.key === "Enter" && event.altKey) {
			event.preventDefault();
			submit(streaming ? "followUp" : "send");
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			submit(streaming ? "steer" : "send");
			return;
		}
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			submit(streaming ? "steer" : "send");
			return;
		}
		if (event.key === "j" && event.ctrlKey) {
			event.preventDefault();
			setText((current) => `${current}\n`);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			void handlers.onAbort().then((restored) => {
				setText((current) => appendBelow(current, restored));
			});
			return;
		}
		if (event.key === "ArrowUp" && event.altKey) {
			event.preventDefault();
			void handlers.onDequeue().then((restored) => {
				setText((current) => appendBelow(current, restored));
			});
			return;
		}
		// Prompt history at the edges of the textarea (spec §4.2).
		// "at the first line" — not merely offset 0, so a value set from history still navigates.
		const beforeCaret = area.value.slice(0, area.selectionStart);
		const afterCaret = area.value.slice(area.selectionEnd);
		if (event.key === "ArrowUp" && !beforeCaret.includes("\n")) {
			const history = readHistory(conversationId);
			if (history.length === 0) return;
			event.preventDefault();
			const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
			setHistoryIndex(next);
			setText(history[next] ?? "");
			return;
		}
		if (event.key === "ArrowDown" && !afterCaret.includes("\n")) {
			const history = readHistory(conversationId);
			if (historyIndex === null) return;
			event.preventDefault();
			const next = historyIndex + 1;
			if (next >= history.length) {
				setHistoryIndex(null);
				setText("");
				return;
			}
			setHistoryIndex(next);
			setText(history[next] ?? "");
		}
	};

	return (
		<div className="border-t border-slate-800 bg-slate-900/60 p-3">
			<div className="flex items-end gap-2">
				<textarea
					ref={ref}
					aria-label="Message"
					className="min-h-[3rem] max-h-64 flex-1 resize-y rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 outline-none focus:border-sky-600"
					placeholder={disabled ? disabledReason : "Ask anything…"}
					value={text}
					disabled={disabled === true}
					spellCheck={false}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
				/>
				{streaming ? (
					<button
						type="button"
						className="rounded bg-rose-700 px-3 py-2 text-sm font-medium hover:bg-rose-600"
						onClick={() => {
							void handlers.onAbort().then((restored) => {
								setText((current) => appendBelow(current, restored));
							});
						}}
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						className="rounded bg-sky-700 px-3 py-2 text-sm font-medium hover:bg-sky-600 disabled:opacity-40"
						disabled={disabled === true || text.trim().length === 0}
						onClick={() => submit("send")}
					>
						Send
					</button>
				)}
			</div>
			<div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
				{streaming ? (
					<span>Enter steers · Alt+Enter queues · Esc stops</span>
				) : (
					<span>Enter sends · Shift+Enter newline · Ctrl+G editor</span>
				)}
				{children}
			</div>
		</div>
	);
}
