// /workspaces — spec/04-workspaces.md. List with live status, create (pick or create a
// folder, optional git init) with live validation, rename/relocate, and a deletion
// confirmation that says in so many words that the files stay (§6).
import type { Workspace } from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiClientError, api } from "../api/client.js";
import { WorkspaceFiles } from "../components/WorkspaceFiles.js";

interface FormState {
	name: string;
	path: string;
	description: string;
	create: boolean;
	gitInit: boolean;
}

const EMPTY: FormState = { name: "", path: "", description: "", create: false, gitInit: false };

/** The server-side directory picker (admin-only route; hidden when it answers 403). */
function DirectoryPicker({ onPick }: { onPick: (path: string) => void }): JSX.Element | null {
	const [at, setAt] = useState<string | undefined>(undefined);
	const browse = useQuery({
		queryKey: ["fs-browse", at ?? ""],
		queryFn: () => api.browse(at),
		retry: false,
	});
	if (browse.isError) return null;
	return (
		<div className="mt-2 rounded border border-slate-800 p-2">
			<div className="flex items-center justify-between text-xs text-slate-400">
				<span className="truncate font-mono">{browse.data?.path ?? "…"}</span>
				<span className="flex gap-2">
					{browse.data?.parent && (
						<button
							type="button"
							className="hover:underline"
							onClick={() => setAt(browse.data.parent ?? undefined)}
						>
							up
						</button>
					)}
					{browse.data && (
						<button
							type="button"
							className="text-sky-300 hover:underline"
							onClick={() => onPick(browse.data.path)}
						>
							use this folder
						</button>
					)}
				</span>
			</div>
			<ul className="mt-1 max-h-32 overflow-auto text-xs">
				{browse.data?.dirs.map((dir) => (
					<li key={dir}>
						<button
							type="button"
							className="w-full truncate px-1 text-left hover:bg-slate-800"
							onClick={() => setAt(`${browse.data.path.replace(/\/$/, "")}/${dir}`)}
						>
							📁 {dir}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function WorkspaceDialog({
	title,
	initial,
	submitLabel,
	allowCreate,
	onClose,
	onSubmit,
	error,
}: {
	title: string;
	initial: FormState;
	submitLabel: string;
	allowCreate: boolean;
	onClose: () => void;
	onSubmit: (form: FormState) => void;
	error: string | null;
}): JSX.Element {
	const [form, setForm] = useState<FormState>(initial);
	const [picker, setPicker] = useState(false);
	const [feedback, setFeedback] = useState<string | null>(null);
	const validate = useMutation({
		mutationFn: (value: FormState) => api.validatePath(value.path, value.create),
		onSuccess: (result) =>
			setFeedback(
				`${result.normalizedPath} — ${result.status.exists ? `${result.status.entryCount ?? 0} entries` : "will be created"}`,
			),
		onError: (err) => setFeedback((err as ApiClientError).message),
	});
	const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
		setForm((current) => ({ ...current, [key]: value }));

	return (
		<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
			<div role="dialog" aria-label={title} className="w-full max-w-lg rounded bg-slate-900 p-4">
				<h2 className="text-sm font-semibold">{title}</h2>
				<div className="mt-3 space-y-2 text-sm">
					<label className="block">
						Name
						<input
							aria-label="Name"
							value={form.name}
							onChange={(event) => set("name", event.target.value)}
							className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1"
						/>
					</label>
					<label className="block">
						Folder
						<input
							aria-label="Folder"
							value={form.path}
							placeholder="/home/you/projects/demo"
							onChange={(event) => set("path", event.target.value)}
							onBlur={() => form.path && validate.mutate(form)}
							className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs"
						/>
					</label>
					<button
						type="button"
						className="text-xs text-sky-300 hover:underline"
						onClick={() => setPicker((open) => !open)}
					>
						{picker ? "Hide browser" : "Browse…"}
					</button>
					{picker && <DirectoryPicker onPick={(path) => set("path", path)} />}
					{feedback && <p className="text-xs text-slate-400">{feedback}</p>}
					<label className="block">
						Description
						<input
							aria-label="Description"
							value={form.description}
							onChange={(event) => set("description", event.target.value)}
							className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1"
						/>
					</label>
					{allowCreate && (
						<>
							<label className="flex items-center gap-2 text-xs">
								<input
									type="checkbox"
									aria-label="Create the folder if it does not exist"
									checked={form.create}
									onChange={(event) => set("create", event.target.checked)}
								/>
								Create the folder if it does not exist
							</label>
							<label className="flex items-center gap-2 text-xs">
								<input
									type="checkbox"
									aria-label="Run git init in it"
									checked={form.gitInit}
									onChange={(event) => set("gitInit", event.target.checked)}
								/>
								Run git init in it
							</label>
						</>
					)}
					{error && <p className="text-xs text-rose-400">{error}</p>}
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" className="rounded px-3 py-1 text-xs" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="rounded bg-sky-600 px-3 py-1 text-xs"
						onClick={() => onSubmit(form)}
					>
						{submitLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

function DeleteDialog({
	workspace,
	onCancel,
	onConfirm,
}: {
	workspace: Workspace;
	onCancel: () => void;
	onConfirm: () => void;
}): JSX.Element {
	// An in-app dialog, never window.confirm: a native modal freezes the tab (M2 notes).
	return (
		<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
			<div
				role="dialog"
				aria-label={`Remove ${workspace.name}`}
				className="w-full max-w-md rounded bg-slate-900 p-4 text-sm"
			>
				<h2 className="font-semibold">Remove “{workspace.name}”?</h2>
				<p className="mt-2 text-slate-300">
					This removes the workspace from piui. The folder and its files are left untouched.
				</p>
				<p className="mt-1 font-mono text-xs text-slate-500">{workspace.path}</p>
				{workspace.activeConversations > 0 && (
					<p className="mt-2 text-xs text-amber-400">
						{workspace.activeConversations} conversation
						{workspace.activeConversations === 1 ? "" : "s"} will keep their transcript and lose the
						workspace.
					</p>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" className="rounded px-3 py-1 text-xs" onClick={onCancel}>
						Cancel
					</button>
					<button
						type="button"
						className="rounded bg-rose-600 px-3 py-1 text-xs"
						onClick={onConfirm}
					>
						Remove
					</button>
				</div>
			</div>
		</div>
	);
}

export function WorkspacesPage(): JSX.Element {
	const queryClient = useQueryClient();
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<Workspace | null>(null);
	const [deleting, setDeleting] = useState<Workspace | null>(null);
	const [openFiles, setOpenFiles] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const invalidate = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
	};
	const create = useMutation({
		mutationFn: (form: FormState) =>
			api.createWorkspace({
				name: form.name,
				path: form.path,
				description: form.description,
				...(form.create ? { create: true } : {}),
				...(form.gitInit ? { gitInit: true } : {}),
			}),
		onSuccess: () => {
			setError(null);
			setCreating(false);
			invalidate();
		},
		onError: (err) => setError((err as ApiClientError).message),
	});
	const patch = useMutation({
		mutationFn: (input: { id: string; form: FormState }) =>
			api.patchWorkspace(input.id, {
				name: input.form.name,
				description: input.form.description,
				path: input.form.path,
			}),
		onSuccess: () => {
			setError(null);
			setEditing(null);
			invalidate();
		},
		onError: (err) => setError((err as ApiClientError).message),
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteWorkspace(id),
		onSuccess: () => {
			setDeleting(null);
			invalidate();
		},
		onError: (err) => setError((err as ApiClientError).message),
	});

	const items = workspaces.data?.items ?? [];

	return (
		<section className="space-y-3">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="text-lg font-semibold">Workspaces</h1>
					<p className="text-xs text-slate-400">
						A workspace is a folder the agent works in. piui never deletes files in it.
					</p>
				</div>
				<button
					type="button"
					className="rounded bg-sky-600 px-3 py-1 text-sm"
					onClick={() => {
						setError(null);
						setCreating(true);
					}}
				>
					New workspace
				</button>
			</header>

			{error && !creating && !editing && <p className="text-xs text-rose-400">{error}</p>}
			{workspaces.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
			{!workspaces.isLoading && items.length === 0 && (
				<p className="rounded border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
					No workspaces yet. Register a folder to let agent-mode conversations work in it.
				</p>
			)}

			<ul className="space-y-2">
				{items.map((workspace) => (
					<li
						key={workspace.id}
						className="rounded border border-slate-800 bg-slate-900/40 p-3 text-sm"
					>
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-semibold">{workspace.name}</span>
							{!workspace.status.exists && (
								<span className="rounded bg-rose-900/60 px-2 py-0.5 text-[11px] text-rose-200">
									Missing
								</span>
							)}
							{workspace.status.isGitRepo && (
								<span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
									git
								</span>
							)}
							{workspace.status.exists && !workspace.status.writable && (
								<span className="rounded bg-amber-900/60 px-2 py-0.5 text-[11px] text-amber-200">
									read-only
								</span>
							)}
							{workspace.status.entryCount !== undefined && (
								<span className="text-[11px] text-slate-500">
									{workspace.status.entryCount} entries
								</span>
							)}
							<span className="ml-auto flex gap-2 text-xs">
								{workspace.status.exists && (
									<button
										type="button"
										className="text-sky-300 hover:underline"
										onClick={() =>
											setOpenFiles((current) => (current === workspace.id ? null : workspace.id))
										}
									>
										Files
									</button>
								)}
								<button
									type="button"
									className="text-slate-300 hover:underline"
									onClick={() => {
										setError(null);
										setEditing(workspace);
									}}
								>
									{workspace.status.exists ? "Edit" : "Relocate"}
								</button>
								<button
									type="button"
									className="text-rose-300 hover:underline"
									aria-label={`Remove workspace ${workspace.name}`}
									onClick={() => setDeleting(workspace)}
								>
									Remove
								</button>
							</span>
						</div>
						<p className="font-mono text-xs text-slate-400">{workspace.path}</p>
						{workspace.description && (
							<p className="text-xs text-slate-400">{workspace.description}</p>
						)}
						{!workspace.status.exists && (
							<p className="mt-1 text-xs text-rose-300">
								The folder was moved, renamed or unmounted — new prompts are blocked until you
								relocate it. Nothing was deleted.
							</p>
						)}
						{workspace.activeConversations > 0 && (
							<p className="mt-1 text-xs text-amber-300">
								{workspace.activeConversations} active conversation
								{workspace.activeConversations === 1 ? "" : "s"} in this workspace — they can
								interfere with each other.
							</p>
						)}
						{openFiles === workspace.id && workspace.status.exists && (
							<WorkspaceFiles workspace={workspace} />
						)}
					</li>
				))}
			</ul>

			{creating && (
				<WorkspaceDialog
					title="New workspace"
					initial={EMPTY}
					submitLabel="Create"
					allowCreate
					error={error}
					onClose={() => setCreating(false)}
					onSubmit={(form) => create.mutate(form)}
				/>
			)}
			{editing && (
				<WorkspaceDialog
					title={`Edit ${editing.name}`}
					initial={{
						name: editing.name,
						path: editing.path,
						description: editing.description,
						create: false,
						gitInit: false,
					}}
					submitLabel="Save"
					allowCreate={false}
					error={error}
					onClose={() => setEditing(null)}
					onSubmit={(form) => patch.mutate({ id: editing.id, form })}
				/>
			)}
			{deleting && (
				<DeleteDialog
					workspace={deleting}
					onCancel={() => setDeleting(null)}
					onConfirm={() => remove.mutate(deleting.id)}
				/>
			)}
		</section>
	);
}
