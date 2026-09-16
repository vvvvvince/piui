// spec/15-commands-and-input.md §5 — the prompt-template sources with counts and a Rescan
// button — plus the About panel of spec/19-deployment.md §5 (the deployment posture).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

export function SettingsPage(): JSX.Element {
	const queryClient = useQueryClient();
	const prompts = useQuery({ queryKey: ["prompts"], queryFn: api.prompts });
	const health = useQuery({ queryKey: ["health"], queryFn: api.health });
	const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta });
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

			{/* spec/19-deployment.md §5 — posture is reported, never guessed. */}
			<div className="rounded border border-slate-800 bg-slate-900/40 p-3">
				<h2 className="text-sm font-semibold">About</h2>
				<dl data-testid="about-posture" className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
					<dt className="text-slate-400">piui version</dt>
					<dd>{health.data?.version ?? "…"}</dd>
					<dt className="text-slate-400">pi version</dt>
					<dd>{health.data?.piVersion ?? "…"}</dd>
					<dt className="text-slate-400">container:</dt>
					<dd>{health.data ? (health.data.container ? "yes" : "no") : "…"}</dd>
					<dt className="text-slate-400">plaintext acknowledged:</dt>
					<dd>
						{health.data ? (health.data.insecureTransportOk ? "yes" : "no") : "…"}
						<span className="ml-2 text-slate-500">(PIUI_INSECURE_TRANSPORT_OK)</span>
					</dd>
					<dt className="text-slate-400">search provider</dt>
					<dd>
						{meta.data?.searchProvider.id ?? "…"}
						{meta.data && !meta.data.searchProvider.configured ? " (not configured)" : ""}
					</dd>
					<dt className="text-slate-400">workspace roots</dt>
					<dd className="font-mono">{(meta.data?.workspaceRoots ?? []).join(", ") || "—"}</dd>
					<dt className="text-slate-400">run limits</dt>
					<dd>
						{meta.data
							? `${meta.data.limits.maxConcurrentRuns} concurrent · ${meta.data.limits.maxRunMinutes} min · ${meta.data.limits.maxUploadMb} MB uploads`
							: "…"}
					</dd>
				</dl>
				{health.data?.defaultCredentials && (
					<p
						data-testid="about-default-credentials"
						className="mt-2 rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-100"
					>
						This piui still uses the default <code>test</code>/<code>test</code> login. Change
						<code> PIUI_USERNAME</code> and <code>PIUI_PASSWORD</code> before publishing the port
						anywhere — a piui account is shell-equivalent trust.
					</p>
				)}
			</div>

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
