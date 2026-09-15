// spec/14-credentials.md §5 — confirm the password, then the caller retries its request once.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../api/client.js";

export interface StepUpDialogProps {
	onResolved: (confirmed: boolean) => void;
}

export function StepUpDialog({ onResolved }: StepUpDialogProps): JSX.Element {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// autoFocus is an a11y smell in general; in a modal that interrupts a request it is correct.
	useEffect(() => inputRef.current?.focus(), []);

	async function submit(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.stepUp(password);
			onResolved(true);
		} catch (err) {
			setError(err instanceof ApiClientError ? err.message : "Could not confirm your password.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
			<form
				role="dialog"
				aria-modal="true"
				aria-label="Step-up re-authentication"
				onSubmit={submit}
				className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl"
			>
				<h2 className="text-base font-semibold">Confirm your password</h2>
				<p className="mt-1 text-sm text-slate-400">
					This action touches provider credentials, so piui asks again.
				</p>
				<label className="mt-4 block text-sm" htmlFor="step-up-password">
					Password
				</label>
				<input
					id="step-up-password"
					ref={inputRef}
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
				/>
				{error ? (
					<p role="alert" className="mt-2 text-sm text-red-400">
						{error}
					</p>
				) : null}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={() => onResolved(false)}
						className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={busy}
						className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
					>
						Confirm
					</button>
				</div>
			</form>
		</div>
	);
}
