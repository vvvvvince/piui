// /c/:id — the chat view: transcript, composer, queue chips, context meter, cost.
import type { CommandDescriptor } from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { AgentSidePanel } from "../components/AgentSidePanel.js";
import { Composer } from "../components/Composer.js";
import { HotkeysDialog } from "../components/HotkeysDialog.js";
import { MessageList } from "../components/MessageList.js";
import { WebSearchToggle } from "../components/WebSearchToggle.js";
import { useConversationStream } from "../hooks/useConversationStream.js";

const joinQueue = (queue: { steering: string[]; followUp: string[] }): string =>
	[...queue.steering, ...queue.followUp].join("\n\n");

export function ConversationPage(): JSX.Element {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const detail = useQuery({
		queryKey: ["conversation", id],
		queryFn: () => api.conversation(id!),
		enabled: Boolean(id),
	});
	const stream = useConversationStream(id);
	// spec/15-commands-and-input.md §1.1 — recomputed per conversation. react-query refetches
	// it on focus, which is what makes a trust decision taken in another tab show up here.
	const commands = useQuery({
		queryKey: ["commands", id],
		queryFn: () => api.commands(id!),
		enabled: Boolean(id),
	});

	// On `done`, refetch the ancillary queries (spec/10-frontend.md §3).
	useEffect(() => {
		if (stream.doneCount === 0) return;
		void queryClient.invalidateQueries({ queryKey: ["conversation", id] });
		void queryClient.invalidateQueries({ queryKey: ["conversations"] });
	}, [stream.doneCount, id, queryClient]);

	const send = useMutation({
		mutationFn: (input: { text: string; streamingBehavior?: "steer" | "followUp" }) =>
			api.sendMessage(id!, input),
	});

	// The globe toggle applies from the next prompt and emits a notice (spec/07-chat-mode.md §3).
	const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta });
	const setWebSearch = useMutation({
		mutationFn: (webSearch: boolean) => api.patchConversation(id!, { webSearch }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["conversation", id] });
		},
	});

	const streaming = stream.state.isStreaming;

	/** spec §2 — the routing table. `expand` never reaches here: it goes to the model. */
	const runCommand = (command: CommandDescriptor, args: string): void => {
		switch (command.name) {
			case "hotkeys":
				setHotkeysOpen(true);
				return;
			case "settings":
				navigate("/settings");
				return;
			case "login":
			case "logout":
				navigate("/settings/providers");
				return;
			case "new":
				navigate("/conversations?new=1");
				return;
			case "resume":
				navigate("/conversations");
				return;
			case "copy": {
				const last = [...stream.messages].reverse().find((m) => m.role === "assistant");
				const text = (last?.blocks ?? [])
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("");
				void navigator.clipboard?.writeText(text);
				setNotice("Copied the last answer to the clipboard.");
				return;
			}
			case "session":
				setNotice(
					`${stream.messages.length} messages · $${(stream.usage?.costTotal ?? 0).toFixed(4)} · ` +
						`ctx ${stream.state.contextPercent ?? 0}%`,
				);
				return;
			case "name":
				if (!args) {
					setNotice("Usage: /name <name>");
					return;
				}
				void api.patchConversation(id!, { title: args }).then(() => {
					void queryClient.invalidateQueries({ queryKey: ["conversation", id] });
					void queryClient.invalidateQueries({ queryKey: ["conversations"] });
					setNotice(`Renamed to “${args}”.`);
				});
				return;
			case "model":
			case "thinking":
				setNotice("Use the model picker in the header of a new conversation (Alt+M).");
				return;
			default:
				setNotice(`\`/${command.name}\` is not implemented yet.`);
		}
	};

	if (!id) return <p>Unknown conversation.</p>;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
				<div className="min-w-0">
					<h1 className="truncate text-sm font-semibold">
						{stream.title ?? detail.data?.title ?? "Chat"}
					</h1>
					<p className="text-xs text-slate-500">
						{detail.data?.model.provider}/{detail.data?.model.modelId}
						{detail.data?.profile ? ` · ${detail.data.profile.name}` : ""}
						{detail.data?.workspace ? ` · ${detail.data.workspace.name}` : ""}
						{detail.data?.webSearch ? " · web search" : ""}
					</p>
				</div>
				<div className="flex items-center gap-4 text-xs text-slate-400">
					{stream.state.contextPercent !== null && (
						<span
							title="Context usage"
							className={
								stream.state.contextPercent > 90
									? "text-rose-400"
									: stream.state.contextPercent > 70
										? "text-amber-400"
										: undefined
							}
						>
							ctx {stream.state.contextPercent}%
						</span>
					)}
					<span>${(stream.usage?.costTotal ?? detail.data?.costTotal ?? 0).toFixed(4)}</span>
					<button type="button" className="underline" onClick={() => setHotkeysOpen(true)}>
						Hotkeys
					</button>
				</div>
			</header>

			{!stream.connected && (
				<div className="bg-amber-900/40 px-4 py-1 text-xs text-amber-200">Reconnecting…</div>
			)}
			{notice && (
				<div className="flex items-center justify-between border-y border-slate-800 bg-slate-900/60 px-4 py-1 text-xs text-slate-300">
					<span>{notice}</span>
					<button type="button" className="underline" onClick={() => setNotice(null)}>
						dismiss
					</button>
				</div>
			)}
			{stream.notices.map((notice) => (
				<div
					key={`${notice.level}:${notice.text}`}
					className="border-y border-slate-800 bg-slate-900/60 px-4 py-1 text-center text-xs text-slate-400"
				>
					{notice.text}
				</div>
			))}

			<div className="flex min-h-0 flex-1">
				<div className="flex min-w-0 flex-1 flex-col">
					<MessageList messages={stream.messages} />
				</div>
				{detail.data?.mode === "agent" && (
					<AgentSidePanel
						conversation={detail.data}
						messages={stream.messages}
						doneCount={stream.doneCount}
					/>
				)}
			</div>

			{(stream.queue.steering.length > 0 || stream.queue.followUp.length > 0) && (
				<ul className="flex flex-wrap gap-2 px-4 pb-2" aria-label="Queued messages">
					{[...stream.queue.steering, ...stream.queue.followUp].map((text) => (
						<li
							key={text}
							className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-300"
						>
							{text.length > 40 ? `${text.slice(0, 40)}…` : text}
						</li>
					))}
				</ul>
			)}

			<Composer
				conversationId={id}
				streaming={streaming}
				commands={commands.data?.items ?? []}
				onCommand={runCommand}
				handlers={{
					onSend: (text) => send.mutateAsync({ text }),
					onSteer: (text) => send.mutateAsync({ text, streamingBehavior: "steer" }),
					onFollowUp: (text) => send.mutateAsync({ text, streamingBehavior: "followUp" }),
					onAbort: async () => {
						const result = await api.abortConversation(id);
						return joinQueue(result.restored);
					},
					onDequeue: async () => joinQueue(await api.clearQueue(id)),
				}}
			>
				{detail.data?.mode !== "agent" && (
					<WebSearchToggle
						value={detail.data?.webSearch === true}
						configured={meta.data?.searchProvider.configured === true}
						disabled={streaming || setWebSearch.isPending}
						onChange={(next) => setWebSearch.mutate(next)}
					/>
				)}
				{detail.data && detail.data.tools.length > 0 && (
					<span className="text-[11px] text-slate-500">
						tools: {detail.data.tools.map((tool) => tool.name).join(", ")}
					</span>
				)}
			</Composer>
			{hotkeysOpen && <HotkeysDialog onClose={() => setHotkeysOpen(false)} />}
		</div>
	);
}
