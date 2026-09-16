// Searchable model combobox grouped by provider (spec/10-frontend.md §2).
import type { ModelInfo } from "@piui/shared";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

export interface ModelPickerProps {
	models: ModelInfo[];
	value: { provider: string; modelId: string } | null;
	onChange(model: ModelInfo): void;
}

/**
 * How many model rows may be in the DOM at once. `GET /api/models` returns every model pi
 * knows (~1355), and rendering them all made the New-chat dialog's first paint visibly slow.
 * Filtering server-side would hide the "greyed, no credentials" models the spec asks for
 * (§07-chat-mode §3), so the list stays complete and only the *rendering* is bounded.
 */
export const MODEL_RENDER_LIMIT = 60;

export function ModelPicker({ models, value, onChange }: ModelPickerProps): JSX.Element {
	const [query, setQuery] = useState("");
	const { groups, hidden } = useMemo(() => {
		const needle = query.toLowerCase();
		const filtered = models.filter((model) =>
			`${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(needle),
		);
		// available first, so the slice always contains what the user can actually pick
		const ordered = [...filtered].sort((a, b) => {
			const rank = (m: ModelInfo): number => (m.available ? 0 : 1);
			return rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
		const shown = ordered.slice(0, MODEL_RENDER_LIMIT);
		const byProvider = new Map<string, ModelInfo[]>();
		for (const model of shown) {
			const list = byProvider.get(model.provider) ?? [];
			list.push(model);
			byProvider.set(model.provider, list);
		}
		return {
			hidden: ordered.length - shown.length,
			// available providers first, then alphabetical
			groups: [...byProvider.entries()].sort((a, b) => {
				const aAvailable = a[1].some((m) => m.available) ? 0 : 1;
				const bAvailable = b[1].some((m) => m.available) ? 0 : 1;
				return aAvailable - bAvailable || a[0].localeCompare(b[0]);
			}),
		};
	}, [models, query]);

	const noneAvailable = models.every((model) => !model.available);

	return (
		<div className="space-y-2">
			<input
				className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
				placeholder="Search models…"
				value={query}
				aria-label="Search models"
				onChange={(event) => setQuery(event.target.value)}
			/>
			{noneAvailable && (
				<p className="rounded border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-200">
					No model credentials found.{" "}
					<Link className="underline" to="/settings/providers">
						Add a provider key
					</Link>{" "}
					— or run <code>pi</code> in a terminal and log in.
				</p>
			)}
			<ul className="max-h-64 space-y-2 overflow-y-auto" aria-label="Models">
				{groups.map(([provider, items]) => (
					<li key={provider}>
						<p className="px-1 text-[11px] uppercase tracking-wide text-slate-500">{provider}</p>
						<ul>
							{items.map((model) => {
								const selected = value?.provider === model.provider && value?.modelId === model.id;
								return (
									<li key={`${model.provider}/${model.id}`}>
										<button
											type="button"
											disabled={!model.available}
											onClick={() => onChange(model)}
											title={model.available ? undefined : "no credentials"}
											className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ${
												selected ? "bg-sky-900/60" : "hover:bg-slate-800"
											} ${model.available ? "" : "opacity-40"}`}
										>
											<span>{model.name}</span>
											<span className="text-[11px] text-slate-500">
												{model.available
													? `${Math.round(model.contextWindow / 1000)}k ctx`
													: "no credentials"}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</li>
				))}
				{hidden > 0 && (
					<li className="px-1 py-1 text-[11px] text-slate-500">
						{hidden} more — refine your search
					</li>
				)}
			</ul>
		</div>
	);
}
