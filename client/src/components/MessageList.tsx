// Transcript rendering (spec/10-frontend.md §2): MessageList + MessageBubble + ToolCallCard.
import type { UiBlock, UiMessage } from "@piui/shared";
import { useEffect, useRef, useState } from "react";
import { MarkdownView } from "./MarkdownView.js";

function ThinkingBlock({ block }: { block: Extract<UiBlock, { type: "thinking" }> }): JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<div className="my-1 rounded border border-slate-800 bg-slate-900/40 p-2 text-xs text-slate-400">
			<button type="button" className="font-medium" onClick={() => setOpen(!open)}>
				{open ? "▾" : "▸"} Thinking
			</button>
			{open && <pre className="mt-1 whitespace-pre-wrap font-mono">{block.text}</pre>}
		</div>
	);
}

function ToolCallCard({ block }: { block: Extract<UiBlock, { type: "tool" }> }): JSX.Element {
	const [open, setOpen] = useState(block.state === "running");
	const colour =
		block.state === "error"
			? "border-rose-800"
			: block.state === "ok"
				? "border-emerald-900"
				: "border-slate-700";
	return (
		<div className={`my-1 rounded border ${colour} bg-slate-900/60 p-2 text-xs`}>
			<button type="button" onClick={() => setOpen(!open)} className="font-mono text-slate-300">
				{open ? "▾" : "▸"} {block.label || block.name || "tool"} · {block.state}
			</button>
			{open && (
				<div className="mt-1 space-y-1">
					<pre className="overflow-x-auto whitespace-pre-wrap break-all text-slate-400">
						{block.argsText ?? JSON.stringify(block.args, null, 2)}
					</pre>
					{block.output !== undefined && (
						<pre className="overflow-x-auto whitespace-pre-wrap break-all text-slate-300">
							{block.output}
							{block.outputTruncated ? "\n…output truncated" : ""}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

function Blocks({ blocks }: { blocks: UiBlock[] }): JSX.Element {
	return (
		<>
			{blocks.map((block) => {
				if (block.type === "text") return <MarkdownView key={block.id} text={block.text} />;
				if (block.type === "thinking") return <ThinkingBlock key={block.id} block={block} />;
				return <ToolCallCard key={block.id} block={block} />;
			})}
		</>
	);
}

export function MessageBubble({ message }: { message: UiMessage }): JSX.Element {
	const isUser = message.role === "user";
	const isError = message.role === "error";
	return (
		<article
			className={`rounded-lg border p-3 ${
				isUser
					? "ml-12 border-sky-900 bg-sky-950/40"
					: isError
						? "mr-12 border-rose-900 bg-rose-950/30"
						: "mr-12 border-slate-800 bg-slate-900/40"
			}`}
			data-role={message.role}
		>
			<Blocks blocks={message.blocks} />
			<footer className="mt-2 flex gap-3 text-[11px] text-slate-500">
				{message.model && <span>{message.model}</span>}
				{message.usage && (
					<span>
						{message.usage.input + message.usage.output} tok · ${message.usage.cost.toFixed(4)}
					</span>
				)}
				{message.stopped && <span className="text-amber-500">stopped</span>}
				{message.streaming && <span className="animate-pulse text-sky-400">▍</span>}
			</footer>
		</article>
	);
}

export function MessageList({ messages }: { messages: UiMessage[] }): JSX.Element {
	const bottom = useRef<HTMLDivElement>(null);
	const container = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		// Stick to the bottom only when the user is already there (spec/10-frontend.md §3).
		const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
		if (distance < 80) bottom.current?.scrollIntoView({ block: "end" });
	}, []);

	return (
		<div
			ref={container}
			className="flex-1 space-y-3 overflow-y-auto p-4"
			aria-live="polite"
			aria-relevant="additions"
		>
			{messages.length === 0 && (
				<p className="text-sm text-slate-500">No messages yet — say something below.</p>
			)}
			{messages.map((message) => (
				<MessageBubble key={message.id} message={message} />
			))}
			<div ref={bottom} />
		</div>
	);
}
