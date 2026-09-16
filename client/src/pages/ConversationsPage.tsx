// /conversations — the list plus the empty state CTAs (spec/10-frontend.md §§1-2, 4.1).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { NewConversationDialog } from "../components/NewConversationDialog.js";

export function ConversationsPage(): JSX.Element {
	const [dialogOpen, setDialogOpen] = useState(false);
	const conversations = useQuery({ queryKey: ["conversations"], queryFn: api.conversations });

	return (
		<div className="space-y-4">
			<header className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Conversations</h1>
				<button
					type="button"
					className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium"
					onClick={() => setDialogOpen(true)}
				>
					New chat
				</button>
			</header>

			{conversations.isPending && (
				<ul className="space-y-2" aria-label="Loading conversations">
					{[0, 1, 2].map((n) => (
						<li key={n} className="h-12 animate-pulse rounded bg-slate-900" />
					))}
				</ul>
			)}

			{conversations.data?.items.length === 0 && (
				<div className="rounded border border-slate-800 p-6 text-center">
					<p className="text-slate-300">No conversations yet.</p>
					<button
						type="button"
						className="mt-3 rounded bg-sky-700 px-4 py-2 text-sm font-medium"
						onClick={() => setDialogOpen(true)}
					>
						New chat
					</button>
					<p className="mt-2 text-xs text-slate-500">Agent tasks arrive in a later milestone.</p>
				</div>
			)}

			<ul className="space-y-1">
				{conversations.data?.items.map((conversation) => (
					<li key={conversation.id}>
						<Link
							to={`/c/${conversation.id}`}
							className="flex items-center justify-between rounded border border-slate-800 px-3 py-2 hover:bg-slate-900"
						>
							<span className="flex items-center gap-2">
								<span aria-hidden>{conversation.mode === "chat" ? "💬" : "⚙"}</span>
								<span className="text-sm">{conversation.title || "Untitled chat"}</span>
								{conversation.isStreaming && (
									<span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
								)}
							</span>
							<span className="flex items-center gap-3 text-xs text-slate-500">
								<span>{conversation.model.modelId}</span>
								<span>${conversation.costTotal.toFixed(3)}</span>
							</span>
						</Link>
					</li>
				))}
			</ul>

			{dialogOpen && <NewConversationDialog onClose={() => setDialogOpen(false)} />}
		</div>
	);
}
