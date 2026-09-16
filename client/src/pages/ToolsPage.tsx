// /tools — the catalog, the web-search Configuration panel and HTTP-tool CRUD
// (spec/05-skills-and-tools.md §B.2).
import type {
	HttpToolDetail,
	SearchTestResponse,
	ToolCatalogItem,
	ToolsResponse,
} from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiClientError, api } from "../api/client.js";
import { HttpToolEditor } from "../components/HttpToolEditor.js";

const KIND_LABEL: Record<string, string> = {
	builtin_pi: "pi built-in",
	builtin_piui: "piui built-in",
	http: "HTTP tool",
	extension: "extension",
};

function ConfigurationPanel({ status }: { status: ToolsResponse["webSearch"] }): JSX.Element {
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const test = useMutation({
		mutationFn: (q: string) => api.testSearch(q),
		onMutate: () => setError(null),
		onError: (err) => setError((err as ApiClientError).message),
	});
	const results = test.data as SearchTestResponse | undefined;

	return (
		<section className="rounded border border-slate-800 bg-slate-900/40 p-3">
			<h2 className="text-sm font-semibold">Web search</h2>
			<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-slate-400">
				<dt>Provider</dt>
				<dd className="font-mono text-slate-200">{status.provider}</dd>
				<dt>Key present</dt>
				<dd className={status.configured ? "text-emerald-400" : "text-amber-400"}>
					{status.configured ? "yes" : "no — set PIUI_SEARCH_API_KEY (or PIUI_SEARXNG_URL)"}
				</dd>
				<dt>Last test</dt>
				<dd>
					{test.isPending ? (
						"running…"
					) : error ? (
						<span className="text-rose-400">{error}</span>
					) : results ? (
						`${results.results.length} results from ${results.provider}`
					) : (
						"never"
					)}
				</dd>
			</dl>

			<div className="mt-3 flex gap-2">
				<label className="sr-only" htmlFor="search-test-query">
					Test query
				</label>
				<input
					id="search-test-query"
					aria-label="Test query"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="latest node lts"
					className="w-64 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
				/>
				<button
					type="button"
					className="rounded bg-slate-700 px-2 py-1 text-xs"
					onClick={() => test.mutate(query || "piui test query")}
				>
					Test search
				</button>
			</div>

			{results && results.results.length > 0 && (
				<ol className="mt-3 space-y-1 text-xs">
					{results.results.slice(0, 3).map((result) => (
						<li key={result.url}>
							<a
								href={result.url}
								target="_blank"
								rel="noreferrer noopener"
								className="text-sky-300 hover:underline"
							>
								{result.title}
							</a>
							<p className="text-slate-500">{result.snippet}</p>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

export function ToolsPage(): JSX.Element {
	const queryClient = useQueryClient();
	const tools = useQuery({ queryKey: ["tools"], queryFn: api.tools });
	const [error, setError] = useState<string | null>(null);
	const toggle = useMutation({
		mutationFn: (input: { name: string; enabled: boolean }) =>
			api.patchTool(input.name, input.enabled),
		onSuccess: () => {
			setError(null);
			void queryClient.invalidateQueries({ queryKey: ["tools"] });
		},
		onError: (err) => setError((err as ApiClientError).message),
	});

	const httpTools = useQuery({ queryKey: ["http-tools"], queryFn: api.httpTools });
	const [editing, setEditing] = useState<HttpToolDetail | "new" | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<HttpToolDetail | null>(null);
	const removeHttp = useMutation({
		mutationFn: (id: string) => api.deleteHttpTool(id),
		onSuccess: () => {
			setConfirmDelete(null);
			refreshTools();
		},
		onError: (err) => setError((err as ApiClientError).message),
	});
	function refreshTools(): void {
		void queryClient.invalidateQueries({ queryKey: ["tools"] });
		void queryClient.invalidateQueries({ queryKey: ["http-tools"] });
	}

	const byKind = new Map<string, ToolCatalogItem[]>();
	for (const item of tools.data?.items ?? []) {
		byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
	}

	return (
		<div className="space-y-4">
			<header>
				<h1 className="text-xl font-semibold">Tools</h1>
				<p className="mt-1 text-sm text-slate-400">
					What a model can be given. Built-ins can be globally disabled; HTTP tools are yours to
					create, edit and delete.
				</p>
			</header>

			{tools.data && <ConfigurationPanel status={tools.data.webSearch} />}
			{error && (
				<p className="rounded border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-200">
					{error}
				</p>
			)}

			{tools.isPending && <p className="text-sm text-slate-500">Loading…</p>}

			<section className="rounded border border-slate-800 bg-slate-900/40 p-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">HTTP tools</h2>
					<button
						type="button"
						data-testid="http-tool-new"
						className="rounded bg-sky-700 px-2 py-1 text-xs"
						onClick={() => setEditing("new")}
					>
						New HTTP tool
					</button>
				</div>
				<p className="mt-1 text-xs text-slate-500">
					Every HTTP tool is dangerous by definition: it sends data from this server to a third
					party. Header values never leave the server — put secrets in
					<code className="mx-1 font-mono">{"$" + "{ENV_VAR}"}</code>references.
				</p>
				<ul className="mt-2 space-y-1 text-xs" data-testid="http-tool-list">
					{(httpTools.data?.items ?? []).map((item) => (
						<li
							key={item.id}
							data-testid={`http-tool-row-${item.name}`}
							className="flex items-center gap-2 rounded border border-slate-800 p-2"
						>
							<span className="w-36 font-mono">{item.name}</span>
							<span className="w-20 text-slate-400">{item.method}</span>
							<span className="flex-1 truncate font-mono text-slate-500">{item.urlTemplate}</span>
							<span className="text-slate-500">used by {item.usedByProfiles}</span>
							<button
								type="button"
								data-testid={`http-tool-edit-${item.name}`}
								className="rounded bg-slate-700 px-2 py-0.5"
								onClick={() => setEditing(item)}
							>
								Edit
							</button>
							<button
								type="button"
								data-testid={`http-tool-delete-${item.name}`}
								className="rounded border border-rose-800 px-2 py-0.5 text-rose-300"
								onClick={() => setConfirmDelete(item)}
							>
								Delete
							</button>
						</li>
					))}
					{(httpTools.data?.items.length ?? 0) === 0 && (
						<li className="text-slate-500">No HTTP tools yet.</li>
					)}
				</ul>
				{editing && (
					<div className="mt-2">
						<HttpToolEditor
							{...(editing === "new" ? {} : { tool: editing })}
							onSaved={() => {
								setEditing(null);
								refreshTools();
							}}
							onCancel={() => setEditing(null)}
						/>
					</div>
				)}
				{confirmDelete && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
						<div
							data-testid="http-tool-delete-dialog"
							className="w-full max-w-md space-y-3 rounded border border-slate-700 bg-slate-900 p-4 text-sm"
						>
							<h3 className="font-semibold">Delete "{confirmDelete.name}"?</h3>
							<p className="text-xs text-slate-300">
								{confirmDelete.usedByProfiles > 0
									? `${confirmDelete.usedByProfiles} profile(s) selected this tool and will lose it.`
									: "No profile selects this tool."}
							</p>
							<div className="flex justify-end gap-2 text-xs">
								<button
									type="button"
									className="rounded bg-slate-700 px-2 py-1"
									onClick={() => setConfirmDelete(null)}
								>
									Cancel
								</button>
								<button
									type="button"
									data-testid="http-tool-delete-confirm"
									className="rounded bg-rose-700 px-2 py-1"
									onClick={() => removeHttp.mutate(confirmDelete.id)}
								>
									Delete
								</button>
							</div>
						</div>
					</div>
				)}
			</section>

			{[...byKind.entries()].map(([kind, items]) => (
				<section key={kind}>
					<h2 className="mb-1 text-sm font-semibold text-slate-300">{KIND_LABEL[kind] ?? kind}</h2>
					<ul className="divide-y divide-slate-800 rounded border border-slate-800">
						{items.map((item) => (
							<li key={item.name} className="flex items-center gap-3 p-2">
								<input
									type="checkbox"
									aria-label={`Enable ${item.name}`}
									checked={item.enabled}
									onChange={(event) =>
										toggle.mutate({ name: item.name, enabled: event.target.checked })
									}
								/>
								<span className="w-36 font-mono text-sm">{item.name}</span>
								<span className="w-40 text-sm text-slate-300">{item.label}</span>
								<span className="flex-1 truncate text-xs text-slate-500">{item.description}</span>
								{item.dangerous && (
									<span className="rounded bg-rose-950 px-1.5 py-0.5 text-[11px] text-rose-300">
										dangerous
									</span>
								)}
								<span className="w-32 text-right text-[11px] text-slate-500">
									used by {item.usedByProfiles} profiles
								</span>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
