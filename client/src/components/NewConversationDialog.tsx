// "New chat" (spec/10-frontend.md §2; the Agent tab lands in M5).
import type { ModelInfo, ThinkingLevel } from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { ModelPicker } from "./ModelPicker.js";

const LAST_MODEL_KEY = "piui.v1.lastChatModel";

export function NewConversationDialog({ onClose }: { onClose(): void }): JSX.Element {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const models = useQuery({ queryKey: ["models"], queryFn: () => api.models() });
	const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta });
	const [selected, setSelected] = useState<ModelInfo | null>(null);
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
	const [webSearch, setWebSearch] = useState(false);

	const remembered = (() => {
		try {
			const raw = window.localStorage.getItem(LAST_MODEL_KEY);
			return raw ? (JSON.parse(raw) as { provider: string; modelId: string }) : null;
		} catch {
			return null;
		}
	})();
	const current =
		selected ??
		models.data?.items.find(
			(model) =>
				model.available &&
				model.provider === remembered?.provider &&
				model.id === remembered?.modelId,
		) ??
		models.data?.items.find((model) => model.available) ??
		null;

	const create = useMutation({
		mutationFn: async () => {
			if (!current) throw new Error("pick a model");
			window.localStorage.setItem(
				LAST_MODEL_KEY,
				JSON.stringify({ provider: current.provider, modelId: current.id }),
			);
			return api.createConversation({
				mode: "chat",
				provider: current.provider,
				modelId: current.id,
				thinkingLevel,
				webSearch,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			});
		},
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["conversations"] });
			onClose();
			navigate(`/c/${result.conversation.id}`);
		},
	});

	return (
		<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
			<div
				role="dialog"
				aria-label="New chat"
				className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-xl"
			>
				<h2 className="mb-3 text-lg font-semibold">New chat</h2>
				{models.isPending && <p className="text-sm text-slate-400">Loading models…</p>}
				{models.data && (
					<ModelPicker
						models={models.data.items}
						value={current ? { provider: current.provider, modelId: current.id } : null}
						onChange={setSelected}
					/>
				)}
				<div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
					{current?.reasoning && (
						<label className="flex items-center gap-2">
							Thinking
							<select
								className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
								value={thinkingLevel}
								onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel)}
							>
								{current.thinkingLevels.map((level) => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						</label>
					)}
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={webSearch}
							disabled={meta.data ? !meta.data.searchProvider.configured : false}
							onChange={(event) => setWebSearch(event.target.checked)}
						/>
						Web search{" "}
						{meta.data && !meta.data.searchProvider.configured && (
							<span className="text-xs text-amber-400">(no search provider configured)</span>
						)}
					</label>
				</div>
				{create.isError && (
					<p className="mt-2 text-sm text-rose-400">{(create.error as Error).message}</p>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" className="rounded px-3 py-1.5 text-sm" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
						disabled={!current || create.isPending}
						onClick={() => create.mutate()}
					>
						Start chat
					</button>
				</div>
			</div>
		</div>
	);
}
