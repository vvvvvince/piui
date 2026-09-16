// The left sidebar: navigation plus recent conversations, kept live by the global SSE channel
// (spec/10-frontend.md §1, spec/09-api.md §9).

import type { ConversationSummary, GlobalEvent } from "@piui/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api/client.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";
import { useIsAdmin } from "./AuthGate.js";

const NAV = [
	{ to: "/conversations", label: "Conversations" },
	{ to: "/profiles", label: "Profiles" },
	{ to: "/workspaces", label: "Workspaces" },
	{ to: "/skills", label: "Skills" },
	{ to: "/tools", label: "Tools" },
	// spec/16-extensions.md §9 — the whole surface is admin-only.
	{ to: "/extensions", label: "Extensions", adminOnly: true },
	// admin-only surfaces live under Settings (spec/18-multi-user.md §5)
	{ to: "/settings/providers", label: "Providers", adminOnly: true },
	{ to: "/settings", label: "Settings", adminOnly: true },
];

const RECENT_LIMIT = 8;

export function Sidebar(): JSX.Element {
	const isAdmin = useIsAdmin();
	const queryClient = useQueryClient();
	const conversations = useQuery({ queryKey: ["conversations"], queryFn: api.conversations });
	const [running, setRunning] = useState<Record<string, true>>({});

	const onEvent = useCallback(
		(event: GlobalEvent) => {
			switch (event.type) {
				case "conversation_state":
					setRunning((current) => {
						const next = { ...current };
						if (event.isStreaming) next[event.conversationId] = true;
						else delete next[event.conversationId];
						return next;
					});
					break;
				case "conversation_done":
					setRunning((current) => {
						if (!current[event.conversationId]) return current;
						const next = { ...current };
						delete next[event.conversationId];
						return next;
					});
					void queryClient.invalidateQueries({ queryKey: ["conversations"] });
					break;
				case "conversation_title":
					// Patch the cache in place: a rename must not cost a refetch (spec §9).
					queryClient.setQueryData<{ items: ConversationSummary[]; nextCursor: string | null }>(
						["conversations"],
						(current) =>
							current
								? {
										...current,
										items: current.items.map((item) =>
											item.id === event.conversationId ? { ...item, title: event.title } : item,
										),
									}
								: current,
					);
					break;
				default:
					break;
			}
		},
		[queryClient],
	);
	useGlobalEvents(onEvent);

	const items = conversations.data?.items ?? [];
	// M6's skill test runs are ephemeral conversations: they ride this channel but are never
	// listed, so anything the list does not know about is deliberately not counted.
	const runningCount = items.filter((item) => running[item.id] || item.isStreaming).length;
	const nav = NAV.filter((item) => !item.adminOnly || isAdmin);

	return (
		<nav
			aria-label="Main"
			className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900 p-3 dark:bg-slate-900"
		>
			<div className="mb-4 px-2 text-lg font-semibold tracking-tight">piui</div>
			<ul className="space-y-1">
				{nav.map((item) => (
					<li key={item.to}>
						<NavLink
							to={item.to}
							className={({ isActive }) =>
								`flex items-center justify-between rounded px-2 py-1.5 text-sm ${
									isActive
										? "bg-slate-800 text-white dark:bg-slate-800"
										: "text-slate-300 hover:bg-slate-800/60"
								}`
							}
						>
							<span>{item.label}</span>
							{item.to === "/conversations" && runningCount > 0 && (
								<span
									data-testid="sidebar-running-count"
									title={`${runningCount} running`}
									className="rounded-full bg-sky-700 px-1.5 text-xs text-white"
								>
									{runningCount}
								</span>
							)}
						</NavLink>
					</li>
				))}
			</ul>

			<div className="mt-6 min-h-0 flex-1 overflow-auto">
				<h2 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
					Recent
				</h2>
				<ul className="space-y-0.5">
					{items.slice(0, RECENT_LIMIT).map((item) => (
						<li key={item.id}>
							<NavLink
								to={`/c/${item.id}`}
								data-testid={`sidebar-conversation-${item.id}`}
								className={({ isActive }) =>
									`flex items-center gap-2 rounded px-2 py-1 text-xs ${
										isActive ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800/60"
									}`
								}
							>
								<span aria-hidden>{item.mode === "chat" ? "💬" : "⚙"}</span>
								<span className="truncate">{item.title || "Untitled"}</span>
								{(running[item.id] || item.isStreaming) && (
									<span
										data-testid={`sidebar-running-${item.id}`}
										title="running"
										className="ml-auto h-2 w-2 shrink-0 rounded-full bg-sky-400 motion-safe:animate-pulse"
									/>
								)}
							</NavLink>
						</li>
					))}
				</ul>
			</div>
		</nav>
	);
}
