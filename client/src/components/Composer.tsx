// The composer with pi TUI input semantics (spec/15-commands-and-input.md §4, normative) and
// the `/` command surface (§§1.2, 2).
import type { CommandDescriptor } from "@piui/shared";
import { useCallback, useEffect, useRef, useState } from "react";

/** spec/09-api.md §10 — what a prompt carries besides text. */
export interface ComposerAttachment {
	uploadId: string;
	url: string;
	mimeType: string;
}

export interface ComposerHandlers {
	onSend(text: string, attachments?: ComposerAttachment[]): unknown;
	onSteer(text: string, attachments?: ComposerAttachment[]): unknown;
	onFollowUp(text: string, attachments?: ComposerAttachment[]): unknown;
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
	/** The conversation's command surface (`GET /conversations/:id/commands`). */
	commands?: CommandDescriptor[];
	/** Executes a `client` / `server` command; `expand` commands go to the model unchanged. */
	onCommand?(command: CommandDescriptor, args: string): void;
	/** spec/07-chat-mode.md §3 — only when the model accepts images. */
	imagesSupported?: boolean;
	/** Uploads one file and resolves with what the prompt should reference. */
	onUpload?(file: File): Promise<ComposerAttachment>;
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

/** The token the `/` menu filters on: only while the first word is still being typed. */
export function commandPrefix(text: string): string | null {
	const match = /^\/([^\s]*)$/.exec(text);
	return match ? match[1]! : null;
}

const splitCommand = (text: string): { name: string; args: string } => {
	const trimmed = text.trimEnd();
	const space = trimmed.indexOf(" ");
	return space === -1
		? { name: trimmed.slice(1), args: "" }
		: { name: trimmed.slice(1, space), args: trimmed.slice(space + 1).trim() };
};

export function Composer({
	streaming,
	handlers,
	conversationId,
	disabled,
	disabledReason,
	commands,
	onCommand,
	imagesSupported,
	onUpload,
	children,
}: ComposerProps): JSX.Element {
	const [text, setText] = useState("");
	const [attached, setAttached] = useState<ComposerAttachment[]>([]);
	const fileRef = useRef<HTMLInputElement>(null);
	const [historyIndex, setHistoryIndex] = useState<number | null>(null);
	const [menuClosed, setMenuClosed] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);

	const attach = useCallback(
		async (file: File): Promise<void> => {
			if (!onUpload) return;
			try {
				setAttached((current) => [...current, { uploadId: "pending", url: "", mimeType: "" }]);
				const uploaded = await onUpload(file);
				setAttached((current) => [...current.filter((a) => a.uploadId !== "pending"), uploaded]);
			} catch (uploadError) {
				setAttached((current) => current.filter((a) => a.uploadId !== "pending"));
				setError((uploadError as Error).message);
			}
		},
		[onUpload],
	);

	const prefix = commandPrefix(text);
	const matches =
		prefix === null || !commands
			? []
			: commands.filter((command) => command.name.toLowerCase().includes(prefix.toLowerCase()));
	const menuOpen = !menuClosed && matches.length > 0;
	const selected = matches[Math.min(highlight, matches.length - 1)];

	const complete = (command: CommandDescriptor): void => {
		setText(`/${command.name} `);
		setMenuClosed(true);
		setError(null);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on conversation switch
	useEffect(() => {
		setText("");
		setHistoryIndex(null);
	}, [conversationId]);

	const submit = useCallback(
		(mode: "send" | "steer" | "followUp") => {
			const value = text.trim();
			if (value.length === 0) return;
			// spec §2 — the routing table. An unknown `/word` is never sent as a prompt.
			if (value.startsWith("/") && commands) {
				const { name, args } = splitCommand(value);
				const command = commands.find((candidate) => candidate.name === name);
				if (!command) {
					setError(`Unknown command \`/${name}\`. Type \`/\` to see available commands.`);
					return;
				}
				if (streaming && !command.availableWhileStreaming) {
					setError(`\`/${name}\` is not available while the agent is running.`);
					return;
				}
				if (command.kind !== "expand") {
					pushHistory(conversationId, value);
					setText("");
					setError(null);
					onCommand?.(command, args);
					return;
				}
			}
			setError(null);
			pushHistory(conversationId, value);
			setText("");
			setHistoryIndex(null);
			const images = attached.length > 0 ? [...attached] : undefined;
			setAttached([]);
			const handler =
				mode === "send"
					? handlers.onSend
					: mode === "steer"
						? handlers.onSteer
						: handlers.onFollowUp;
			// No attachments: call with one argument, so "send this text" stays the simple case.
			if (images) handler(value, images);
			else handler(value);
		},
		[text, conversationId, handlers, commands, onCommand, streaming, attached],
	);

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
		const area = event.currentTarget;
		// The dropdown swallows keys first — exactly pi's precedence (spec §4.2).
		if (menuOpen && selected) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				setHighlight((current) => (current + delta + matches.length) % matches.length);
				return;
			}
			if (event.key === "Tab" || event.key === "Enter") {
				event.preventDefault();
				complete(selected);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setMenuClosed(true);
				return;
			}
		}
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
			{menuOpen && (
				<div
					role="listbox"
					aria-label="Commands"
					className="mb-2 max-h-64 overflow-y-auto rounded border border-slate-700 bg-slate-950 text-sm"
				>
					{matches.map((command, index) => (
						<button
							key={command.name}
							role="option"
							aria-selected={command === selected}
							data-command={command.name}
							type="button"
							className={`flex w-full items-baseline gap-2 px-2 py-1 text-left ${
								command === selected ? "bg-slate-800" : ""
							}`}
							onMouseEnter={() => setHighlight(index)}
							onClick={() => {
								complete(command);
								ref.current?.focus();
							}}
						>
							<span className="font-mono text-slate-200">{command.display}</span>
							{command.argumentHint && (
								<span className="font-mono text-xs text-slate-500">{command.argumentHint}</span>
							)}
							<span className="truncate text-xs text-slate-400">— {command.description}</span>
							{command.location && (
								<span className="ml-auto rounded bg-slate-800 px-1 text-[10px] text-slate-400">
									{command.location}
								</span>
							)}
						</button>
					))}
				</div>
			)}
			{error && (
				<p role="alert" className="mb-2 text-xs text-rose-300">
					{error}
				</p>
			)}
			{attached.length > 0 && (
				<ul className="mb-2 flex flex-wrap gap-2" data-testid="composer-attachments">
					{attached.map((attachment) => (
						<li key={attachment.uploadId} className="relative">
							<img
								src={attachment.url}
								alt="attachment"
								className="h-14 w-14 rounded border border-slate-700 object-cover"
							/>
							<button
								type="button"
								aria-label="Remove attachment"
								className="absolute -right-1 -top-1 rounded-full bg-slate-800 px-1 text-[10px] text-slate-300"
								onClick={() =>
									setAttached(attached.filter((a) => a.uploadId !== attachment.uploadId))
								}
							>
								✕
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="flex items-end gap-2">
				<input
					ref={fileRef}
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					className="hidden"
					data-testid="composer-file-input"
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) void attach(file);
					}}
				/>
				<button
					type="button"
					data-testid="composer-attach"
					aria-label="Attach image"
					title={
						imagesSupported === false
							? "This model does not accept images"
							: "Attach an image (or paste one)"
					}
					className="rounded border border-slate-700 px-2 py-2 text-sm disabled:opacity-40"
					disabled={disabled === true || imagesSupported === false || !onUpload}
					onClick={() => fileRef.current?.click()}
				>
					📎
				</button>
				<textarea
					ref={ref}
					aria-label="Message"
					className="min-h-[3rem] max-h-64 flex-1 resize-y rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 outline-none focus:border-sky-600"
					placeholder={disabled ? disabledReason : "Ask anything…"}
					value={text}
					disabled={disabled === true}
					spellCheck={false}
					onChange={(event) => {
						setText(event.target.value);
						setHighlight(0);
						setMenuClosed(false);
						setError(null);
					}}
					onKeyDown={onKeyDown}
					onPaste={(event) => {
						// spec/10-frontend.md §2: Ctrl+V attaches an image.
						const file = [...event.clipboardData.files][0];
						if (file?.type.startsWith("image/")) {
							event.preventDefault();
							void attach(file);
						}
					}}
					onDragOver={(event) => event.preventDefault()}
					onDrop={(event) => {
						const file = [...event.dataTransfer.files][0];
						if (file?.type.startsWith("image/")) {
							event.preventDefault();
							void attach(file);
						}
					}}
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
