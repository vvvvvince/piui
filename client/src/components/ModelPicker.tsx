// Searchable model combobox grouped by provider (spec/10-frontend.md §2).
import type { ModelInfo } from "@piui/shared";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

export interface ModelPickerProps {
	models: ModelInfo[];
	value: { provider: string; modelId: string } | null;
	onChange(model: ModelInfo): void;
}

export function ModelPicker({ models, value, onChange }: ModelPickerProps): JSX.Element {
	const [query, setQuery] = useState("");
	const groups = useMemo(() => {
		const filtered = models.filter((model) =>
			`${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()),
		);
		const byProvider = new Map<string, ModelInfo[]>();
		for (const model of filtered) {
			const list = byProvider.get(model.provider) ?? [];
			list.push(model);
			byProvider.set(model.provider, list);
		}
		// available providers first, then alphabetical
		return [...byProvider.entries()].sort((a, b) => {
			const aAvailable = a[1].some((m) => m.available) ? 0 : 1;
			const bAvailable = b[1].some((m) => m.available) ? 0 : 1;
			return aAvailable - bAvailable || a[0].localeCompare(b[0]);
		});
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
							{items.slice(0, 40).map((model) => {
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
			</ul>
		</div>
	);
}
