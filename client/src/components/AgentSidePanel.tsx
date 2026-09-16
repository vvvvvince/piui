// spec/08-agent-mode.md §3 — the agent side panel: Files · Tools · Profile · Memory · Usage.
import type { ConversationDetail, UiMessage } from "@piui/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { MemoryPanel } from "../pages/ProfilesPage.js";

type Tab = "files" | "tools" | "profile" | "memory" | "usage";
const TABS: Tab[] = ["files", "tools", "profile", "memory", "usage"];

/** Paths the run wrote or edited — the Files tab dots, and the tree refetch trigger. */
export function touchedPaths(messages: UiMessage[]): string[] {
	const paths: string[] = [];
	for (const message of messages) {
		for (const block of message.blocks) {
			if (block.type !== "tool" || block.state !== "ok") continue;
			if (block.name !== "write" && block.name !== "edit") continue;
			const path = (block.args as { path?: string } | undefined)?.path;
			if (path) paths.push(path.replace(/^\.\//, ""));
		}
	}
	return [...new Set(paths)];
}

export function AgentSidePanel({
	conversation,
	messages,
	doneCount,
}: {
	conversation: ConversationDetail;
	messages: UiMessage[];
	doneCount: number;
}): JSX.Element {
	const [tab, setTab] = useState<Tab>("files");
	const touched = touchedPaths(messages);

	return (
		<aside className="flex w-80 shrink-0 flex-col border-l border-slate-800">
			<div role="tablist" className="flex gap-1 border-b border-slate-800 px-2 text-xs">
				{TABS.map((name) => (
					<button
						key={name}
						role="tab"
						type="button"
						aria-selected={tab === name}
						className={`px-2 py-1 capitalize ${
							tab === name ? "border-b-2 border-sky-600 text-slate-100" : "text-slate-400"
						}`}
						onClick={() => setTab(name)}
					>
						{name}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-2 text-sm">
				{tab === "files" && (
					<FilesTab conversation={conversation} touched={touched} doneCount={doneCount} />
				)}
				{tab === "tools" && <ToolsTab conversation={conversation} />}
				{tab === "profile" && <ProfileTab conversation={conversation} />}
				{tab === "memory" && <MemoryTab conversation={conversation} />}
				{tab === "usage" && <UsageTab messages={messages} />}
			</div>
		</aside>
	);
}

function FilesTab({
	conversation,
	touched,
	doneCount,
}: {
	conversation: ConversationDetail;
	touched: string[];
	doneCount: number;
}): JSX.Element {
	const [dir, setDir] = useState("");
	const [file, setFile] = useState<string | null>(null);
	const workspaceId = conversation.workspace?.id;
	// The query key carries what the run changed: a completed write/edit refetches the tree
	// immediately, `done` refetches it again at the end of the run (M5 open item 1).
	const tree = useQuery({
		queryKey: ["agent-tree", workspaceId, dir, touched.length, doneCount],
		queryFn: () => api.workspaceTree(workspaceId!, dir),
		enabled: Boolean(workspaceId),
	});
	const preview = useQuery({
		queryKey: ["agent-file", workspaceId, file],
		queryFn: () => api.workspaceFile(workspaceId!, file!),
		enabled: Boolean(workspaceId) && file !== null,
		retry: false,
	});

	if (!workspaceId) return <p className="text-slate-400">This conversation has no workspace.</p>;
	const segments = dir.split("/").filter(Boolean);

	return (
		<div>
			<nav className="flex flex-wrap gap-1 text-xs text-slate-400">
				<button type="button" onClick={() => setDir("")}>
					{conversation.workspace?.name}
				</button>
				{segments.map((segment, index) => (
					<span key={`${segment}-${String(index)}`}>
						{" / "}
						<button type="button" onClick={() => setDir(segments.slice(0, index + 1).join("/"))}>
							{segment}
						</button>
					</span>
				))}
			</nav>
			{tree.isError && (
				<p className="mt-1 text-xs text-rose-400">{(tree.error as Error).message}</p>
			)}
			<ul className="mt-1">
				{tree.data?.entries.map((entry) => {
					const full = dir ? `${dir}/${entry.name}` : entry.name;
					const isTouched = touched.includes(full);
					return (
						<li key={entry.name}>
							<button
								type="button"
								{...(isTouched ? { title: "touched by this conversation" } : {})}
								className={`w-full truncate px-1 py-0.5 text-left text-xs hover:bg-slate-800 ${
									entry.hidden ? "text-slate-500" : "text-slate-200"
								}`}
								onClick={() => (entry.kind === "dir" ? setDir(full) : setFile(full))}
							>
								{entry.kind === "dir" ? "📁" : "📄"} {entry.name}
								{isTouched && <span className="ml-1 text-emerald-400">●</span>}
							</button>
						</li>
					);
				})}
			</ul>
			{preview.data && (
				<pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-2 text-[11px]">
					{preview.data.content}
				</pre>
			)}
		</div>
	);
}

function ToolsTab({ conversation }: { conversation: ConversationDetail }): JSX.Element {
	return (
		<ul className="space-y-1">
			{conversation.tools.map((tool) => (
				<li key={tool.name} className="rounded border border-slate-800 p-1 text-xs">
					<span className="font-mono">{tool.name}</span>{" "}
					<span className="text-slate-400">{tool.label}</span>
					{tool.dangerous && (
						<span className="ml-1 rounded bg-rose-900 px-1 text-[10px] text-rose-200">
							dangerous
						</span>
					)}
				</li>
			))}
			{conversation.tools.length === 0 && (
				<li className="text-slate-400">This profile grants no tools.</li>
			)}
		</ul>
	);
}

function ProfileTab({ conversation }: { conversation: ConversationDetail }): JSX.Element {
	const profileId = conversation.profile?.id;
	const profile = useQuery({
		queryKey: ["profile", profileId],
		queryFn: () => api.profile(profileId!),
		enabled: Boolean(profileId),
	});
	if (!profileId) return <p className="text-slate-400">This conversation has no profile.</p>;
	return (
		<div className="space-y-2 text-xs">
			<p className="font-medium text-slate-200">{conversation.profile?.name}</p>
			{profile.data?.warnings.map((warning) => (
				<p key={warning} className="text-amber-400">
					{warning}
				</p>
			))}
			<p className="text-slate-400">{profile.data?.skillIds.length ?? 0} skills active</p>
			<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2">
				{profile.data?.agentsMd || "No AGENTS.md"}
			</pre>
			<details>
				<summary className="cursor-pointer text-slate-400">System prompt</summary>
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2">
					{conversation.systemPromptPreview}
				</pre>
			</details>
		</div>
	);
}

function MemoryTab({ conversation }: { conversation: ConversationDetail }): JSX.Element {
	const profileId = conversation.profile?.id;
	if (!profileId) return <p className="text-slate-400">This conversation has no profile.</p>;
	return (
		<MemoryPanel
			profileId={profileId}
			enabled={conversation.tools.some((tool) => tool.name === "memory_append")}
			onToggle={() => {
				/* memory is a profile setting: change it on the profile page */
			}}
		/>
	);
}

function UsageTab({ messages }: { messages: UiMessage[] }): JSX.Element {
	const rows = messages.filter((message) => message.usage);
	const total = rows.reduce((sum, message) => sum + (message.usage?.cost ?? 0), 0);
	return (
		<div className="text-xs">
			<p className="mb-1 text-slate-300">${total.toFixed(4)} total</p>
			<ul className="space-y-1">
				{rows.map((message) => (
					<li key={message.id} className="flex justify-between text-slate-400">
						<span>{(message.usage?.input ?? 0) + (message.usage?.output ?? 0)} tokens</span>
						<span>${(message.usage?.cost ?? 0).toFixed(4)}</span>
					</li>
				))}
				{rows.length === 0 && <li className="text-slate-400">No usage recorded yet.</li>}
			</ul>
		</div>
	);
}
