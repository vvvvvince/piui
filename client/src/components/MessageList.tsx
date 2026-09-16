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

/** A collapsible card with a one-line summary — the shape every agent tool card shares. */
function Card({
	block,
	icon,
	title,
	summary,
	children,
	openByDefault,
}: {
	block: ToolBlock;
	icon: string;
	title: string;
	summary?: string;
	children?: React.ReactNode;
	openByDefault?: boolean;
}): JSX.Element {
	// Successful cards collapse, errors stay open (spec/08-agent-mode.md §2 collapse policy).
	const [open, setOpen] = useState(openByDefault ?? block.state === "error");
	const colour =
		block.state === "error"
			? "border-rose-800"
			: block.state === "ok"
				? "border-emerald-900"
				: "border-slate-700";
	return (
		<div className={`my-1 rounded border ${colour} bg-slate-900/60 p-2 text-xs`}>
			<button type="button" onClick={() => setOpen(!open)} className="text-left text-slate-300">
				{open ? "▾" : "▸"} {icon} <span className="font-mono">{title}</span>{" "}
				{block.state === "running" ? (
					<span className="animate-pulse text-sky-400">running…</span>
				) : block.state === "pending" ? (
					<span className="text-slate-500">starting…</span>
				) : block.state === "error" ? (
					<span className="text-rose-400">failed</span>
				) : (
					<span className="text-slate-500">{summary ?? "done"}</span>
				)}
			</button>
			{open && <div className="mt-1 space-y-1">{children}</div>}
		</div>
	);
}

function Output({ block }: { block: ToolBlock }): JSX.Element | null {
	if (block.output === undefined) return null;
	return (
		<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-slate-300">
			{block.output}
			{block.outputTruncated ? "\n…output truncated" : ""}
		</pre>
	);
}

const argOf = (block: ToolBlock, key: string): string | undefined => {
	const value = (block.args as Record<string, unknown> | undefined)?.[key];
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
};

/** `edit` — pi hands us a unified patch and a display diff (spike plan/spikes/09). */
function EditCard({ block }: { block: ToolBlock }): JSX.Element {
	const details = (block.details ?? {}) as { diff?: string; patch?: string };
	const diff = details.diff ?? details.patch ?? "";
	return (
		<Card block={block} icon="E" title={argOf(block, "path") ?? "edit"} summary="edited">
			<pre className="max-h-72 overflow-auto rounded bg-slate-950 p-2 font-mono">
				{diff.split("\n").map((line, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no other identity
						key={index}
						className={
							line.startsWith("+")
								? "text-emerald-400"
								: line.startsWith("-")
									? "text-rose-400"
									: "text-slate-400"
						}
					>
						{line}
					</div>
				))}
			</pre>
			<Output block={block} />
		</Card>
	);
}

/** `bash` — command + streaming stdout; pi reports failure through the state, not an exit code. */
function BashCard({ block }: { block: ToolBlock }): JSX.Element {
	const command = argOf(block, "command") ?? "";
	return (
		<Card
			block={block}
			icon="$"
			title={command}
			summary="exited 0"
			openByDefault={block.state !== "ok"}
		>
			<div className="flex items-center gap-2">
				<code className="flex-1 rounded bg-slate-950 px-2 py-1">{command}</code>
				<button
					type="button"
					className="rounded border border-slate-700 px-1"
					onClick={() => void navigator.clipboard?.writeText(command)}
				>
					copy
				</button>
			</div>
			<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black p-2 text-slate-200">
				{block.output ?? ""}
			</pre>
		</Card>
	);
}

function FileCard({ block }: { block: ToolBlock }): JSX.Element {
	const path = argOf(block, "path") ?? ".";
	if (block.name === "write") {
		const content = (block.args as { content?: string } | undefined)?.content ?? "";
		return (
			<Card block={block} icon="W" title={path} summary={`${content.length} B written`}>
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2">
					{content}
				</pre>
			</Card>
		);
	}
	if (block.name === "read") {
		const offset = Number(argOf(block, "offset") ?? Number.NaN);
		const limit = Number(argOf(block, "limit") ?? Number.NaN);
		const range =
			Number.isFinite(offset) && Number.isFinite(limit)
				? `lines ${offset}–${offset + limit - 1}`
				: "whole file";
		return (
			<Card block={block} icon="R" title={path} summary={range}>
				<p className="text-slate-500">{range}</p>
				<Output block={block} />
			</Card>
		);
	}
	// grep / find / ls: a compact result list
	const lines = (block.output ?? "").split("\n").filter(Boolean);
	return (
		<Card
			block={block}
			icon="?"
			title={argOf(block, "pattern") ?? path}
			summary={`${lines.length} results`}
		>
			<ul className="max-h-64 overflow-auto font-mono text-slate-300">
				{lines.slice(0, 200).map((line) => (
					<li key={line} className="truncate">
						{line}
					</li>
				))}
			</ul>
		</Card>
	);
}

function MemoryCard({ block }: { block: ToolBlock }): JSX.Element {
	const note = (block.args as { note?: string } | undefined)?.note ?? "";
	return (
		<div className="my-1 rounded border border-slate-800 bg-slate-900/40 px-2 py-1 text-xs text-slate-300">
			{block.output?.startsWith("Remembered") ? block.output : `Remembered: ${note}`}
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
				// Agent-mode renderers (spec/08-agent-mode.md §2).
				if (block.name === "edit") return <EditCard key={block.id} block={block} />;
				if (block.name === "bash" || block.name === "powershell")
					return <BashCard key={block.id} block={block} />;
				if (["read", "write", "grep", "find", "ls"].includes(block.name))
					return <FileCard key={block.id} block={block} />;
				if (block.name === "memory_append") return <MemoryCard key={block.id} block={block} />;
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
