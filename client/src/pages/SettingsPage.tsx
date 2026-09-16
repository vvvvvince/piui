// spec/15-commands-and-input.md §5 — the three prompt-template sources with counts and a
// Rescan button. The rest of /settings is M7.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

export function SettingsPage(): JSX.Element {
	const queryClient = useQueryClient();
	const prompts = useQuery({ queryKey: ["prompts"], queryFn: api.prompts });
	const [result, setResult] = useState<string | null>(null);
	const rescan = useMutation({
		mutationFn: api.rescanPrompts,
		onSuccess: (delta) => {
			setResult(`${delta.added} added · ${delta.updated} updated · ${delta.removed} removed`);
			void queryClient.invalidateQueries({ queryKey: ["prompts"] });
		},
	});

	return (
		<section className="space-y-4">
			<header>
				<h1 className="text-lg font-semibold">Settings</h1>
				<p className="text-xs text-slate-400">
					Providers live under{" "}
					<Link to="/settings/providers" className="underline">
						Providers
					</Link>
					.
				</p>
			</header>

			<div className="rounded border border-slate-800 bg-slate-900/40 p-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">Prompt templates</h2>
					<button
						type="button"
						className="rounded bg-slate-700 px-3 py-1 text-xs"
						disabled={rescan.isPending}
						onClick={() => rescan.mutate()}
					>
						Rescan
					</button>
				</div>
				<p className="mt-1 text-xs text-slate-400">
					Markdown files, one command each. Later sources win; the menu shows which one did.
				</p>
				{result && <p className="mt-1 text-xs text-emerald-300">{result}</p>}
				<ul className="mt-2 space-y-1 text-xs">
					{(prompts.data?.sources ?? []).map((source) => (
						<li key={source.path} className="flex gap-2">
							<span className="w-14 rounded bg-slate-800 px-1 text-center text-slate-300">
								{source.location}
							</span>
							<span className="font-mono text-slate-400">{source.path}</span>
							<span className="ml-auto text-slate-500">{source.count}</span>
						</li>
					))}
				</ul>
				<ul className="mt-3 space-y-1 text-xs">
					{(prompts.data?.items ?? []).map((item) => (
						<li key={item.name}>
							<span className="font-mono text-slate-200">/{item.name}</span>{" "}
							{item.argumentHint && (
								<span className="font-mono text-slate-500">{item.argumentHint}</span>
							)}{" "}
							<span className="text-slate-400">— {item.description}</span>{" "}
							<span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">
								{item.location}
							</span>
							{item.shadows && item.shadows.length > 0 && (
								<span className="ml-1 text-[10px] text-amber-400">
									shadows {item.shadows.join(", ")}
								</span>
							)}
						</li>
					))}
					{(prompts.data?.items.length ?? 0) === 0 && (
						<li className="text-slate-400">
							No templates yet — drop a <span className="font-mono">name.md</span> into one of the
							folders above and press Rescan.
						</li>
					)}
				</ul>
			</div>
		</section>
	);
}
