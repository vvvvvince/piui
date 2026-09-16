// /extensions — spec/16-extensions.md §7.3. Install by paste or URL-then-review, global
// enable toggle, health, uninstall (in-app dialog, never window.confirm) and rescan.
import type { ExtensionSummary, FetchExtensionResponse } from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiClientError, api } from "../api/client.js";

function Chips({ label, items }: { label: string; items: string[] }): JSX.Element | null {
	if (items.length === 0) return null;
	return (
		<span className="flex flex-wrap items-center gap-1">
			<span className="text-slate-500">{label}</span>
			{items.map((item) => (
				<code
					key={item}
					className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[11px] text-slate-200"
				>
					{item}
				</code>
			))}
		</span>
	);
}

export function ExtensionsPage(): JSX.Element {
	const queryClient = useQueryClient();
	const list = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
	const [error, setError] = useState<string | null>(null);
	const [pasteName, setPasteName] = useState("");
	const [pasteSource, setPasteSource] = useState("");
	const [url, setUrl] = useState("");
	const [review, setReview] = useState<FetchExtensionResponse | null>(null);
	const [reviewed, setReviewed] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<ExtensionSummary | null>(null);
	const [rescan, setRescan] = useState<string | null>(null);

	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["extensions"] });
		void queryClient.invalidateQueries({ queryKey: ["tools"] });
	};
	const fail = (err: unknown): void => setError((err as ApiClientError).message);

	const install = useMutation({
		mutationFn: (body: { name: string; source: string; origin?: string }) =>
			api.installExtension(body),
		onMutate: () => setError(null),
		onSuccess: () => {
			setPasteName("");
			setPasteSource("");
			setReview(null);
			setReviewed(false);
			setUrl("");
			refresh();
		},
		onError: fail,
	});
	const fetchSource = useMutation({
		mutationFn: (target: string) => api.fetchExtension(target),
		onMutate: () => setError(null),
		onSuccess: (data) => {
			setReview(data);
			setReviewed(false);
		},
		onError: fail,
	});
	const toggle = useMutation({
		mutationFn: (input: { id: string; enabled: boolean }) =>
			api.patchExtension(input.id, { enabled: input.enabled }),
		onMutate: () => setError(null),
		onSuccess: refresh,
		onError: fail,
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteExtension(id),
		onMutate: () => setError(null),
		onSuccess: () => {
			setConfirmDelete(null);
			refresh();
		},
		onError: fail,
	});
	const doRescan = useMutation({
		mutationFn: () => api.rescanExtensions(),
		onMutate: () => setError(null),
		onSuccess: (result) => {
			setRescan(`${result.added} added · ${result.updated} updated · ${result.removed} removed`);
			refresh();
		},
		onError: fail,
	});

	const items = list.data?.items ?? [];
	const installEnabled = list.data?.installEnabled !== false;
	const broken = items.filter((item) => item.enabled && item.loadError);

	return (
		<div className="space-y-4 p-4">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="text-lg font-semibold">Extensions</h1>
					<p className="text-xs text-slate-500">
						Extensions are installed globally and run inside the piui server process. Changes apply
						to new conversations.
					</p>
				</div>
				<button
					type="button"
					data-testid="extensions-rescan"
					className="rounded bg-slate-700 px-2 py-1 text-xs"
					disabled={!installEnabled}
					onClick={() => doRescan.mutate()}
				>
					Rescan
				</button>
			</header>

			{rescan && <p className="text-xs text-slate-400">{rescan}</p>}
			{error && (
				<p data-testid="extensions-error" className="text-xs text-rose-400">
					{error}
				</p>
			)}
			{!installEnabled && (
				<p className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
					Installing, editing and removing extensions is disabled on this server
					(PIUI_DISABLE_EXTENSION_INSTALL=1). Per-profile switches still work.
				</p>
			)}
			{broken.length > 0 && (
				<p
					data-testid="extensions-broken-banner"
					className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-200"
				>
					{broken.length} enabled extension{broken.length > 1 ? "s" : ""} failed to load and{" "}
					{broken.length > 1 ? "are" : "is"} not active: {broken.map((e) => e.name).join(", ")}.
				</p>
			)}

			<ul className="space-y-2" data-testid="extensions-list">
				{items.map((item) => (
					<li
						key={item.id}
						data-testid={`extension-row-${item.name}`}
						className="rounded border border-slate-800 bg-slate-900/40 p-3 text-sm"
					>
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<span className="font-medium">{item.name}</span>
									<span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400">
										{item.source}
									</span>
									{item.loadError ? (
										<span className="text-[11px] text-rose-400">⚠ failed to load</span>
									) : (
										<span className="text-[11px] text-emerald-400">✓ healthy</span>
									)}
									{item.disabledInProfiles > 0 && (
										<span className="text-[11px] text-slate-500">
											disabled in {item.disabledInProfiles} profile
											{item.disabledInProfiles > 1 ? "s" : ""}
										</span>
									)}
								</div>
								<p className="truncate font-mono text-[11px] text-slate-500">{item.path}</p>
								{item.loadError && (
									<p
										data-testid={`extension-error-${item.name}`}
										className="mt-1 font-mono text-[11px] text-rose-300"
									>
										{item.loadError}
									</p>
								)}
								<div className="mt-1 flex flex-wrap gap-3 text-[11px]">
									<Chips label="tools:" items={item.tools} />
									<Chips label="commands:" items={item.commands.map((c) => `/${c}`)} />
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2 text-xs">
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										data-testid={`extension-enabled-${item.name}`}
										checked={item.enabled}
										disabled={!installEnabled}
										onChange={(event) =>
											toggle.mutate({ id: item.id, enabled: event.target.checked })
										}
									/>
									enabled
								</label>
								<button
									type="button"
									data-testid={`extension-delete-${item.name}`}
									className="rounded border border-rose-800 px-2 py-1 text-rose-300"
									disabled={!installEnabled}
									onClick={() => setConfirmDelete(item)}
								>
									Uninstall
								</button>
							</div>
						</div>
					</li>
				))}
				{items.length === 0 && <li className="text-xs text-slate-500">No extensions installed.</li>}
			</ul>

			<section className="rounded border border-slate-800 bg-slate-900/40 p-3">
				<h2 className="text-sm font-semibold">Install from source</h2>
				<div className="mt-2 space-y-2">
					<input
						aria-label="Extension name"
						data-testid="extension-paste-name"
						value={pasteName}
						disabled={!installEnabled}
						onChange={(event) => setPasteName(event.target.value)}
						placeholder="my-extension"
						className="w-64 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
					/>
					<textarea
						aria-label="Extension source"
						data-testid="extension-paste-source"
						value={pasteSource}
						disabled={!installEnabled}
						onChange={(event) => setPasteSource(event.target.value)}
						placeholder="export default function (pi) { … }"
						className="h-40 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs"
					/>
					<button
						type="button"
						data-testid="extension-paste-install"
						className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white"
						disabled={!installEnabled || pasteName === "" || pasteSource === ""}
						onClick={() =>
							install.mutate({ name: pasteName, source: pasteSource, origin: "paste" })
						}
					>
						Install
					</button>
				</div>
			</section>

			<section className="rounded border border-slate-800 bg-slate-900/40 p-3">
				<h2 className="text-sm font-semibold">Install from URL</h2>
				<p className="text-xs text-slate-500">
					piui fetches the source and shows it to you. Nothing runs until you install it.
				</p>
				<div className="mt-2 flex gap-2">
					<input
						aria-label="Extension URL"
						data-testid="extension-url"
						value={url}
						disabled={!installEnabled}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://example.com/extension.ts"
						className="w-96 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
					/>
					<button
						type="button"
						data-testid="extension-url-fetch"
						className="rounded bg-slate-700 px-2 py-1 text-xs"
						disabled={!installEnabled || url === ""}
						onClick={() => fetchSource.mutate(url)}
					>
						Fetch
					</button>
				</div>

				{review && (
					<div className="mt-3 space-y-2" data-testid="extension-review">
						<p className="text-xs text-slate-400">
							{review.bytes} bytes · sha256{" "}
							<code className="font-mono">{review.sha256.slice(0, 16)}…</code>
						</p>
						<textarea
							readOnly
							aria-label="Fetched source"
							data-testid="extension-review-source"
							value={review.source}
							className="h-56 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs"
						/>
						<label className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								data-testid="extension-review-checkbox"
								checked={reviewed}
								onChange={(event) => setReviewed(event.target.checked)}
							/>
							I have reviewed this code
						</label>
						<button
							type="button"
							data-testid="extension-review-install"
							className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
							disabled={!reviewed}
							onClick={() =>
								install.mutate({ name: review.name, source: review.source, origin: url })
							}
						>
							Install
						</button>
					</div>
				)}
			</section>

			{confirmDelete && (
				<div
					role="dialog"
					aria-modal="true"
					aria-label="Uninstall extension"
					data-testid="extension-delete-dialog"
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
				>
					<div className="w-full max-w-md rounded border border-slate-700 bg-slate-900 p-4 text-sm">
						<h2 className="text-base font-semibold">Uninstall “{confirmDelete.name}”?</h2>
						<p className="mt-2 text-xs text-slate-400">
							{confirmDelete.tools.length > 0 &&
								`Tools that will disappear: ${confirmDelete.tools.join(", ")}. `}
							{confirmDelete.commands.length > 0 &&
								`Commands: ${confirmDelete.commands.map((c) => `/${c}`).join(", ")}. `}
							{confirmDelete.disabledInProfiles > 0 &&
								`${confirmDelete.disabledInProfiles} profile(s) reference it. `}
							{confirmDelete.source === "managed"
								? "The file is moved to the piui trash folder."
								: "The file is left untouched; piui only forgets it."}
						</p>
						<div className="mt-3 flex justify-end gap-2">
							<button
								type="button"
								className="rounded border border-slate-700 px-3 py-1 text-xs"
								onClick={() => setConfirmDelete(null)}
							>
								Cancel
							</button>
							<button
								type="button"
								data-testid="extension-delete-confirm"
								className="rounded bg-rose-700 px-3 py-1 text-xs font-medium text-white"
								onClick={() => remove.mutate(confirmDelete.id)}
							>
								Uninstall
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
