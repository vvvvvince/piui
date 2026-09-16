// /settings/providers — ProviderTable + CredentialDialog (spec/14-credentials.md §4).
import type {
	AuthFlowView,
	ProviderStatus,
	ProvidersResponse,
	VerifyProviderResponse,
} from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ApiClientError, api } from "../api/client.js";

function StatusPill({ provider }: { provider: ProviderStatus }): JSX.Element {
	if (!provider.configured) {
		return (
			<span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
				Not configured
			</span>
		);
	}
	if (provider.source === "stored") {
		return (
			<span className="rounded bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-200">
				Configured (stored)
			</span>
		);
	}
	return (
		<span className="rounded bg-sky-900/60 px-2 py-0.5 text-xs text-sky-200">
			Configured ({provider.source}
			{provider.label ? `: ${provider.label}` : ""})
		</span>
	);
}

function CredentialDialog({
	provider,
	onClose,
}: {
	provider: ProviderStatus;
	onClose(): void;
}): JSX.Element {
	const queryClient = useQueryClient();
	const [view, setView] = useState<AuthFlowView | null>(null);
	const [fastPathKey, setFastPathKey] = useState("");
	const [answer, setAnswer] = useState("");
	const [reveal, setReveal] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const invalidate = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["providers"] });
		void queryClient.invalidateQueries({ queryKey: ["models"] });
	};

	const apply = (next: AuthFlowView): void => {
		setView(next);
		setAnswer("");
		if (next.state === "done") invalidate();
	};

	const start = useMutation({
		mutationFn: (key: string) => api.startAuth(provider.id, key.length > 0 ? { apiKey: key } : {}),
		onSuccess: apply,
		onError: (err) => setError((err as ApiClientError).message),
	});

	const respond = useMutation({
		mutationFn: (value: string) => {
			if (view?.state !== "prompting") throw new Error("no pending prompt");
			return api.respondAuth(provider.id, {
				flowId: view.flowId,
				promptId: view.prompt.id,
				value,
			});
		},
		onSuccess: apply,
		onError: (err) => setError((err as ApiClientError).message),
	});

	// While the flow is working, long-poll it (spec §4.4).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `apply` is stable enough here
	useEffect(() => {
		if (view?.state !== "working") return;
		let cancelled = false;
		void api
			.pollAuth(view.flowId, view.version)
			.then((next) => {
				if (!cancelled) apply(next);
			})
			.catch(() => {
				/* the flow expired; the user can retry */
			});
		return () => {
			cancelled = true;
		};
	}, [view]);

	const close = (): void => {
		if (view && (view.state === "prompting" || view.state === "working")) {
			void api.cancelAuth(provider.id, view.flowId).catch(() => {});
		}
		setFastPathKey("");
		onClose();
	};

	return (
		<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
			<div
				role="dialog"
				aria-label={`Add a key for ${provider.name}`}
				className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4"
			>
				<h2 className="text-lg font-semibold">{provider.name}</h2>
				<p className="mt-1 text-xs text-slate-500">
					The key is sent to this server only and stored in pi's auth file.
				</p>

				{view?.events.map((event) => (
					<p key={`${event.type}-${JSON.stringify(event)}`} className="mt-2 text-xs text-slate-400">
						{event.type === "auth_url" ? (
							<a className="underline" href={event.url} target="_blank" rel="noreferrer noopener">
								{event.url}
							</a>
						) : event.type === "device_code" ? (
							<span className="font-mono">
								{event.userCode} · {event.verificationUri}
							</span>
						) : (
							event.message
						)}
					</p>
				))}

				{!view && (
					<form
						className="mt-3 space-y-2"
						onSubmit={(formEvent) => {
							formEvent.preventDefault();
							setError(null);
							start.mutate(fastPathKey);
						}}
					>
						<label className="block text-sm" htmlFor="fast-path-key">
							API key
						</label>
						<input
							id="fast-path-key"
							type={reveal ? "text" : "password"}
							className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
							autoComplete="off"
							spellCheck={false}
							value={fastPathKey}
							onChange={(changeEvent) => setFastPathKey(changeEvent.target.value)}
						/>
						<label className="flex items-center gap-2 text-xs text-slate-400">
							<input
								type="checkbox"
								checked={reveal}
								onChange={(changeEvent) => setReveal(changeEvent.target.checked)}
							/>
							Show key
						</label>
						<button
							type="submit"
							className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
							disabled={start.isPending}
						>
							Save key
						</button>
					</form>
				)}

				{view?.state === "prompting" && (
					<form
						className="mt-3 space-y-2"
						onSubmit={(formEvent) => {
							formEvent.preventDefault();
							setError(null);
							respond.mutate(answer);
						}}
					>
						<label className="block text-sm" htmlFor="prompt-answer">
							{view.prompt.message}
						</label>
						{view.prompt.type === "select" ? (
							<select
								id="prompt-answer"
								className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
								value={answer}
								onChange={(changeEvent) => setAnswer(changeEvent.target.value)}
							>
								<option value="">Choose…</option>
								{view.prompt.options.map((option) => (
									<option key={option.id} value={option.id}>
										{option.label}
									</option>
								))}
							</select>
						) : (
							<input
								id="prompt-answer"
								type={view.prompt.type === "secret" && !reveal ? "password" : "text"}
								placeholder={view.prompt.placeholder}
								className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
								autoComplete="off"
								spellCheck={false}
								value={answer}
								onChange={(changeEvent) => setAnswer(changeEvent.target.value)}
							/>
						)}
						<button type="submit" className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium">
							Continue
						</button>
					</form>
				)}

				{view?.state === "working" && <p className="mt-3 text-sm text-slate-400">Working…</p>}
				{view?.state === "done" && (
					<p className="mt-3 text-sm text-emerald-300">
						{view.status.availableModelCount} models available.
						{view.warning ? ` (${view.warning})` : ""}
					</p>
				)}
				{view?.state === "error" && <p className="mt-3 text-sm text-rose-400">{view.message}</p>}
				{error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

				<div className="mt-4 flex justify-end gap-2">
					{view?.state === "error" && (
						<button
							type="button"
							className="rounded bg-slate-700 px-3 py-1.5 text-sm"
							onClick={() => {
								setView(null);
								setError(null);
							}}
						>
							Retry
						</button>
					)}
					<button type="button" className="rounded px-3 py-1.5 text-sm" onClick={close}>
						{view?.state === "done" ? "Close" : "Cancel"}
					</button>
				</div>
			</div>
		</div>
	);
}

export function ProvidersPage(): JSX.Element {
	const queryClient = useQueryClient();
	const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
	const [dialogFor, setDialogFor] = useState<ProviderStatus | null>(null);
	// An in-app confirmation, not window.confirm: a native modal blocks the whole tab.
	const [signOutFor, setSignOutFor] = useState<ProviderStatus | null>(null);
	const [verified, setVerified] = useState<Record<string, VerifyProviderResponse>>({});
	const [error, setError] = useState<string | null>(null);

	// Another tab changed a credential: refresh (spec/14-credentials.md §9.6).
	useEffect(() => {
		const source = new EventSource("/api/events");
		source.onmessage = (event: MessageEvent<string>) => {
			try {
				const parsed = JSON.parse(event.data) as { type: string };
				if (parsed.type === "providers_changed") {
					void queryClient.invalidateQueries({ queryKey: ["providers"] });
					void queryClient.invalidateQueries({ queryKey: ["models"] });
				}
			} catch {
				/* ignore */
			}
		};
		return () => source.close();
	}, [queryClient]);

	const verify = useMutation({
		mutationFn: (id: string) => api.verifyProvider(id),
		onSuccess: (result, id) => setVerified((current) => ({ ...current, [id]: result })),
	});
	const signOut = useMutation({
		mutationFn: (id: string) => api.deleteAuth(id),
		onSuccess: (status) => {
			setError(null);
			// Patch the row from the response: a background refetch keeps the *previous* data on
			// screen while it runs, which made the deleted key look like it was still configured
			// (seen in the browser, M3).
			queryClient.setQueryData<ProvidersResponse>(["providers"], (current) =>
				current
					? {
							...current,
							items: current.items.map((item) => (item.id === status.id ? status : item)),
						}
					: current,
			);
			void queryClient.invalidateQueries({ queryKey: ["providers"] });
			void queryClient.invalidateQueries({ queryKey: ["models"] });
		},
		onError: (err) => setError((err as ApiClientError).message),
	});

	const writesEnabled = providers.data?.credentialWritesEnabled === true;

	return (
		<div className="space-y-4">
			<header>
				<h1 className="text-xl font-semibold">Models &amp; providers</h1>
				<p className="mt-1 text-sm text-slate-400">
					Keys are stored in <code>{providers.data?.authPath ?? "~/.pi/agent/auth.json"}</code>,
					shared with the pi CLI.
				</p>
				{providers.data && !writesEnabled && (
					<p className="mt-2 rounded border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-200">
						Credential writes are disabled on this deployment (
						<code>PIUI_DISABLE_CREDENTIAL_WRITES=1</code>). Status and Test still work.
					</p>
				)}
			</header>

			{error && <p className="text-sm text-rose-400">{error}</p>}

			<table className="w-full text-left text-sm">
				<thead className="text-xs uppercase text-slate-500">
					<tr>
						<th className="py-1">Provider</th>
						<th className="py-1">Status</th>
						<th className="py-1">Models</th>
						<th className="py-1 text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					{providers.data?.items.map((provider) => {
						const apiKeyMethod = provider.methods.find((method) => method.type === "api_key");
						const oauth = provider.methods.find((method) => method.type === "oauth");
						const ambient = apiKeyMethod !== undefined && !apiKeyMethod.interactive;
						return (
							<tr key={provider.id} className="border-t border-slate-800">
								<td className="py-2">{provider.name}</td>
								<td className="py-2">
									<StatusPill provider={provider} />
								</td>
								<td className="py-2 text-xs text-slate-400">
									{provider.modelCount} models ({provider.availableModelCount} available)
									{verified[provider.id] && (
										<span
											className={
												verified[provider.id]!.configured
													? "ml-2 text-emerald-400"
													: "ml-2 text-rose-400"
											}
										>
											{verified[provider.id]!.configured ? "✓ works" : "✗ not configured"}
										</span>
									)}
								</td>
								<td className="py-2 text-right">
									<div className="flex justify-end gap-2">
										{ambient ? (
											<span
												className="text-xs text-slate-500"
												title="This provider reads credentials from the environment. Set them where piui runs."
											>
												configured via environment
											</span>
										) : (
											<button
												type="button"
												className="rounded bg-slate-700 px-2 py-1 text-xs disabled:opacity-40"
												disabled={!writesEnabled}
												onClick={() => setDialogFor(provider)}
											>
												{provider.source === "stored" ? "Replace key" : "Add key"}
											</button>
										)}
										<button
											type="button"
											className="rounded bg-slate-800 px-2 py-1 text-xs"
											onClick={() => verify.mutate(provider.id)}
										>
											Test
										</button>
										{provider.removable && (
											<button
												type="button"
												className="rounded bg-rose-900 px-2 py-1 text-xs disabled:opacity-40"
												disabled={!writesEnabled}
												onClick={() => setSignOutFor(provider)}
											>
												Sign out
											</button>
										)}
										{oauth && (
											<button
												type="button"
												disabled
												title="Not available in this version — use the `pi` CLI"
												className="rounded bg-slate-800 px-2 py-1 text-xs opacity-40"
											>
												{oauth.loginLabel ?? "OAuth login"}
											</button>
										)}
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>

			{dialogFor && <CredentialDialog provider={dialogFor} onClose={() => setDialogFor(null)} />}

			{signOutFor && (
				<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
					<div
						role="dialog"
						aria-label={`Sign out of ${signOutFor.name}`}
						className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-4"
					>
						<h2 className="text-lg font-semibold">Sign out of {signOutFor.name}?</h2>
						<p className="mt-2 text-sm text-slate-400">
							The stored key is deleted. Running tasks keep the auth they already resolved, but may
							fail on their next request.
						</p>
						<div className="mt-4 flex justify-end gap-2">
							<button
								type="button"
								className="rounded px-3 py-1.5 text-sm"
								onClick={() => setSignOutFor(null)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="rounded bg-rose-800 px-3 py-1.5 text-sm font-medium"
								onClick={() => {
									signOut.mutate(signOutFor.id);
									setSignOutFor(null);
								}}
							>
								Sign out
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
