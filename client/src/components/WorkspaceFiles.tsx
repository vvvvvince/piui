// spec/04-workspaces.md §3/§5 — the read-only file browser, the file preview and the git
// badge. The tree refetches when a run finishes (`conversation_done` on /api/events), so a
// file the agent just wrote appears without a page reload (§7.4).
import type { GlobalEvent, Workspace } from "@piui/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type ApiClientError, api } from "../api/client.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";

export function WorkspaceFiles({ workspace }: { workspace: Workspace }): JSX.Element {
	const queryClient = useQueryClient();
	const [dir, setDir] = useState("");
	const [file, setFile] = useState<string | null>(null);

	const tree = useQuery({
		queryKey: ["workspace-tree", workspace.id, dir],
		queryFn: () => api.workspaceTree(workspace.id, dir),
	});
	const git = useQuery({
		queryKey: ["workspace-git", workspace.id],
		queryFn: () => api.workspaceGit(workspace.id),
		enabled: workspace.status.isGitRepo,
	});
	const preview = useQuery({
		queryKey: ["workspace-file", workspace.id, file],
		queryFn: () => api.workspaceFile(workspace.id, file!),
		enabled: file !== null,
		retry: false,
	});

	// A run just ended: whatever it wrote is on disk now (spec §7.4).
	useGlobalEvents(
		useCallback(
			(event: GlobalEvent) => {
				if (event.type !== "conversation_done") return;
				void queryClient.invalidateQueries({ queryKey: ["workspace-tree", workspace.id] });
				void queryClient.invalidateQueries({ queryKey: ["workspace-git", workspace.id] });
			},
			[queryClient, workspace.id],
		),
	);

	const segments = dir.split("/").filter(Boolean);

	return (
		<div className="mt-3 grid gap-3 border-t border-slate-800 pt-3 md:grid-cols-2">
			<div>
				<div className="flex items-center justify-between gap-2">
					<nav className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
						<button type="button" className="hover:underline" onClick={() => setDir("")}>
							{workspace.name}
						</button>
						{segments.map((segment, index) => (
							<span key={segment + String(index)}>
								{" / "}
								<button
									type="button"
									className="hover:underline"
									onClick={() => setDir(segments.slice(0, index + 1).join("/"))}
								>
									{segment}
								</button>
							</span>
						))}
					</nav>
					{git.data?.available && (
						<span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">
							{git.data.branch}
							{git.data.dirtyCount ? ` · ${git.data.dirtyCount} dirty` : " · clean"}
							{git.data.ahead ? ` · ↑${git.data.ahead}` : ""}
							{git.data.behind ? ` · ↓${git.data.behind}` : ""}
						</span>
					)}
				</div>

				{tree.isError && (
					<p className="mt-2 text-xs text-rose-400">{(tree.error as ApiClientError).message}</p>
				)}
				<ul className="mt-2 max-h-64 overflow-auto text-sm">
					{tree.data?.entries.map((entry) => (
						<li key={entry.name}>
							<button
								type="button"
								className={`w-full truncate px-1 py-0.5 text-left hover:bg-slate-800 ${
									entry.hidden ? "text-slate-500" : "text-slate-200"
								}`}
								onClick={() =>
									entry.kind === "dir"
										? setDir(dir ? `${dir}/${entry.name}` : entry.name)
										: setFile(dir ? `${dir}/${entry.name}` : entry.name)
								}
							>
								{entry.kind === "dir" ? "📁" : "📄"} {entry.name}
								{entry.size !== undefined && (
									<span className="ml-2 text-[11px] text-slate-500">{entry.size} B</span>
								)}
							</button>
						</li>
					))}
				</ul>
				{tree.data?.truncated && (
					<p className="text-[11px] text-amber-400">Only the first 1000 entries are listed.</p>
				)}
			</div>

			<div className="min-w-0">
				{file === null ? (
					<p className="text-xs text-slate-500">Select a file to preview it (read-only).</p>
				) : preview.isError ? (
					<p className="text-xs text-rose-400">{(preview.error as ApiClientError).message}</p>
				) : preview.data ? (
					<>
						<p className="truncate text-xs text-slate-400">
							{preview.data.path} · {preview.data.size} B · {preview.data.language}
							{preview.data.truncated ? " · truncated at 512 KB" : ""}
						</p>
						<pre className="mt-1 max-h-64 overflow-auto rounded bg-slate-950 p-2 text-[11px] text-slate-200">
							{preview.data.content}
						</pre>
					</>
				) : (
					<p className="text-xs text-slate-500">Loading…</p>
				)}
			</div>
		</div>
	);
}
