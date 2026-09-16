// spec/10-frontend.md §5 — Cmd/Ctrl+K: jump to a conversation, new chat, new agent task.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";

interface Entry {
	id: string;
	label: string;
	to: string;
}

export function CommandPalette(): JSX.Element | null {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const navigate = useNavigate();
	const inputRef = useRef<HTMLInputElement>(null);
	const conversations = useQuery({
		queryKey: ["conversations"],
		queryFn: api.conversations,
		enabled: open,
	});

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setOpen((current) => !current);
				setQuery("");
			} else if (event.key === "Escape") {
				setOpen(false);
			}
		};
		globalThis.addEventListener?.("keydown", onKey);
		return () => globalThis.removeEventListener?.("keydown", onKey);
	}, []);

	// Focus the input when the palette opens (autofocus is a lint-flagged a11y smell).
	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const entries = useMemo<Entry[]>(() => {
		const base: Entry[] = [
			{ id: "new-chat", label: "New chat", to: "/conversations?new=chat" },
			{ id: "new-agent", label: "New agent task", to: "/conversations?new=agent" },
			{ id: "nav-profiles", label: "Profiles", to: "/profiles" },
			{ id: "nav-workspaces", label: "Workspaces", to: "/workspaces" },
			{ id: "nav-skills", label: "Skills", to: "/skills" },
			{ id: "nav-tools", label: "Tools", to: "/tools" },
			{ id: "nav-settings", label: "Settings", to: "/settings" },
		];
		const recents = (conversations.data?.items ?? []).map((item) => ({
			id: item.id,
			label: item.title || "Untitled conversation",
			to: `/c/${item.id}`,
		}));
		const all = [...base, ...recents];
		const needle = query.trim().toLowerCase();
		return needle ? all.filter((entry) => entry.label.toLowerCase().includes(needle)) : all;
	}, [conversations.data, query]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center p-16">
			{/* A real button, so closing by clicking away is keyboard-reachable too. */}
			<button
				type="button"
				aria-label="Close the command palette"
				className="absolute inset-0 h-full w-full cursor-default bg-black/60"
				onClick={() => setOpen(false)}
			/>
			<div
				role="dialog"
				aria-label="Command palette"
				className="relative w-full max-w-lg rounded border border-slate-700 bg-slate-900 p-3 shadow-xl"
			>
				<input
					ref={inputRef}
					data-testid="command-palette-input"
					aria-label="Search commands and conversations"
					className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
					placeholder="Jump to…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && entries[0]) {
							navigate(entries[0].to);
							setOpen(false);
						}
					}}
				/>
				<ul className="mt-2 max-h-80 overflow-auto">
					{entries.map((entry) => (
						<li key={entry.id}>
							<button
								type="button"
								className="w-full rounded px-2 py-1 text-left text-sm text-slate-200 hover:bg-slate-800"
								onClick={() => {
									navigate(entry.to);
									setOpen(false);
								}}
							>
								{entry.label}
							</button>
						</li>
					))}
					{entries.length === 0 && (
						<li className="px-2 py-1 text-sm text-slate-500">No matches.</li>
					)}
				</ul>
			</div>
		</div>
	);
}
