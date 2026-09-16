// /c/:id — the chat view: transcript, composer, queue chips, context meter, cost.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
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
	const queryClient = useQueryClient();
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	const detail = useQuery({
		queryKey: ["conversation", id],
		queryFn: () => api.conversation(id!),
		enabled: Boolean(id),
	});
	const stream = useConversationStream(id);

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
