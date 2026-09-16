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

type ToolBlock = Extract<UiBlock, { type: "tool" }>;

interface SearchDetails {
	provider?: string;
	query?: string;
	results?: { title?: string; url?: string; snippet?: string }[];
}

interface FetchDetails {
	url?: string;
	finalUrl?: string;
	status?: number;
	contentType?: string;
	chars?: number;
	title?: string;
}

const searchDetails = (block: ToolBlock): SearchDetails => (block.details ?? {}) as SearchDetails;
const fetchDetails = (block: ToolBlock): FetchDetails => (block.details ?? {}) as FetchDetails;

/** Every URL this message's web tools touched, in order, deduplicated (spec/07 §3). */
export function sourcesOf(message: UiMessage): { url: string; domain: string }[] {
	const urls: string[] = [];
	for (const block of message.blocks) {
		if (block.type !== "tool") continue;
		if (block.name === "web_search") {
			for (const result of searchDetails(block).results ?? []) {
				if (result.url) urls.push(result.url);
			}
		} else if (block.name === "web_fetch") {
			const details = fetchDetails(block);
			const url = details.finalUrl ?? details.url;
			if (url) urls.push(url);
		}
	}
	const seen = new Set<string>();
	const out: { url: string; domain: string }[] = [];
	for (const url of urls) {
		if (seen.has(url)) continue;
		seen.add(url);
		try {
			out.push({ url, domain: new URL(url).hostname.replace(/^www\./, "") });
		} catch {
			/* a tool returned something that is not a URL: skip it rather than crash the bubble */
		}
	}
	return out;
}

function SourcesFooter({ message }: { message: UiMessage }): JSX.Element | null {
	const sources = sourcesOf(message);
	if (sources.length === 0) return null;
	return (
		<ul aria-label="Sources" className="mt-2 flex flex-wrap gap-2 border-t border-slate-800 pt-2">
			{sources.map((source, index) => (
				<li key={source.url}>
					<a
						href={source.url}
						target="_blank"
						rel="noreferrer noopener"
						title={source.url}
						className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-500"
					>
						<span className="text-slate-500">{index + 1}</span>
						<img
							alt=""
							aria-hidden="true"
							width={12}
							height={12}
							src={`https://icons.duckduckgo.com/ip3/${source.domain}.ico`}
							// offline (or a site without a favicon): leave no broken-image box behind
							onError={(event) => {
								event.currentTarget.style.display = "none";
							}}
						/>
						{source.domain}
					</a>
				</li>
			))}
		</ul>
	);
}

function WebSearchCard({ block }: { block: ToolBlock }): JSX.Element {
	const [open, setOpen] = useState(false);
	const details = searchDetails(block);
	const query = details.query ?? (block.args as { query?: string } | undefined)?.query ?? "";
	const results = details.results ?? [];
	return (
		<div className="my-1 rounded border border-slate-700 bg-slate-900/60 p-2 text-xs">
			<button type="button" onClick={() => setOpen(!open)} className="text-left text-slate-300">
				{open ? "▾" : "▸"} 🔍 Web search · <span className="font-mono">{query}</span>{" "}
				{block.state === "running" ? (
					<span className="animate-pulse text-sky-400">searching…</span>
				) : block.state === "error" ? (
					<span className="text-rose-400">failed</span>
				) : (
					<span className="text-slate-500">{results.length} results</span>
				)}
			</button>
			{results.length > 0 && (
				<ol className="mt-1 space-y-0.5">
					{results.map((result, index) => (
						<li key={result.url ?? index} className="truncate">
							<a
								href={result.url}
								target="_blank"
								rel="noreferrer noopener"
								className="text-sky-300 hover:underline"
							>
								{result.title || result.url}
							</a>
						</li>
					))}
				</ol>
			)}
			{open && block.output !== undefined && (
				<pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-slate-400">
					{block.output}
				</pre>
			)}
		</div>
	);
}

function WebFetchCard({ block }: { block: ToolBlock }): JSX.Element {
	const [open, setOpen] = useState(false);
	const details = fetchDetails(block);
	const url = details.finalUrl ?? details.url ?? (block.args as { url?: string })?.url ?? "";
	return (
		<div className="my-1 rounded border border-slate-700 bg-slate-900/60 p-2 text-xs">
			<button type="button" onClick={() => setOpen(!open)} className="text-left text-slate-300">
				{open ? "▾" : "▸"} 📄 Fetch · <span className="font-mono">{url}</span>{" "}
				{block.state === "running" ? (
					<span className="animate-pulse text-sky-400">fetching…</span>
				) : block.state === "error" ? (
					<span className="text-rose-400">failed</span>
				) : (
					<span className="text-slate-500">
						{details.status ?? ""} · {details.chars ?? block.output?.length ?? 0} chars
					</span>
				)}
			</button>
			{open && block.output !== undefined && (
				<pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-slate-400">
					{block.output}
				</pre>
			)}
		</div>
	);
}

function ToolCallCard({ block }: { block: ToolBlock }): JSX.Element {
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
				// The web tools get their own cards (spec/07-chat-mode.md §3).
				if (block.name === "web_search") return <WebSearchCard key={block.id} block={block} />;
				if (block.name === "web_fetch") return <WebFetchCard key={block.id} block={block} />;
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
			{!isUser && <SourcesFooter message={message} />}
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
