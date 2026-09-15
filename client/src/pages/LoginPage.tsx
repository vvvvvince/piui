// spec/06-auth.md §6 — centered card, generic error text, default-credentials hint in V1.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiClientError, api } from "../api/client.js";

export function LoginPage(): JSX.Element {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const health = useQuery({ queryKey: ["health"], queryFn: api.health, retry: false });

	const login = useMutation({
		mutationFn: () => api.login(username, password),
		onSuccess: async (data) => {
			queryClient.setQueryData(["me"], { user: data.user, stepUpValidUntil: null });
			await queryClient.invalidateQueries({ queryKey: ["me"] });
			const next = params.get("next");
			navigate(next?.startsWith("/") ? next : "/", { replace: true });
		},
		onError: (err) => {
			setError(
				err instanceof ApiClientError ? err.message : "Could not reach the server. Try again.",
			);
		},
	});

	function submit(event: FormEvent): void {
		event.preventDefault();
		setError(null);
		login.mutate();
	}

	return (
		<div className="flex h-full items-center justify-center p-6">
			<form
				onSubmit={submit}
				className="w-full max-w-sm rounded-lg border border-slate-800 bg-slate-900 p-6"
			>
				<h1 className="text-lg font-semibold">Sign in</h1>
				<p className="mt-1 text-sm text-slate-400">piui — web UI for the pi coding agent</p>

				<label className="mt-5 block text-sm" htmlFor="login-username">
					Username
				</label>
				<input
					id="login-username"
					autoComplete="username"
					value={username}
					onChange={(e) => setUsername(e.target.value)}
					className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
				/>

				<label className="mt-3 block text-sm" htmlFor="login-password">
					Password
				</label>
				<input
					id="login-password"
					type="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
				/>

				{error ? (
					<p role="alert" className="mt-3 text-sm text-red-400">
						{error}
					</p>
				) : null}

				<button
					type="submit"
					disabled={login.isPending}
					className="mt-5 w-full rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
				>
					Sign in
				</button>

				{health.data?.defaultCredentials ? (
					<p className="mt-4 text-center text-xs text-amber-400">
						Default credentials: test / test
					</p>
				) : null}
			</form>
		</div>
	);
}
