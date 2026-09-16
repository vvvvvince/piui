// spec/16-extensions.md §5 — an extension's `select`/`confirm`/`input`/`editor` dialog.
// In-app, never `window.confirm` (that froze the tab in M2).
import type { UiRequest } from "@piui/shared";
import { useState } from "react";

export interface ExtensionDialogProps {
	request: UiRequest;
	onAnswer(answer: { value?: string; confirmed?: boolean; cancelled?: boolean }): void;
}

export function ExtensionDialog({ request, onAnswer }: ExtensionDialogProps): JSX.Element {
	const [text, setText] = useState(request.prefill ?? "");

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={request.title ?? "Extension request"}
			data-testid="extension-dialog"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		>
			<div className="w-full max-w-lg rounded border border-slate-700 bg-slate-900 p-4 text-sm">
				<h2 className="mb-2 text-base font-semibold">{request.title ?? "An extension asks"}</h2>
				{request.message && <p className="mb-3 text-slate-300">{request.message}</p>}

				{request.method === "select" && (
					<ul className="mb-3 space-y-1">
						{(request.options ?? []).map((option) => (
							<li key={option}>
								<button
									type="button"
									data-testid={`extension-dialog-option-${option}`}
									className="w-full rounded border border-slate-700 px-3 py-1 text-left hover:bg-slate-800"
									onClick={() => onAnswer({ value: option })}
								>
									{option}
								</button>
							</li>
						))}
					</ul>
				)}

				{(request.method === "input" || request.method === "editor") &&
					(request.method === "editor" ? (
						<textarea
							data-testid="extension-dialog-text"
							className="mb-3 h-40 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs"
							value={text}
							onChange={(event) => setText(event.target.value)}
						/>
					) : (
						<input
							data-testid="extension-dialog-text"
							className="mb-3 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1"
							placeholder={request.placeholder ?? ""}
							value={text}
							onChange={(event) => setText(event.target.value)}
						/>
					))}

				<div className="flex justify-end gap-2">
					<button
						type="button"
						data-testid="extension-dialog-cancel"
						className="rounded border border-slate-700 px-3 py-1"
						onClick={() => onAnswer({ cancelled: true })}
					>
						Cancel
					</button>
					{request.method !== "select" && (
						<button
							type="button"
							data-testid="extension-dialog-ok"
							className="rounded bg-sky-600 px-3 py-1 font-medium text-white"
							onClick={() =>
								onAnswer(request.method === "confirm" ? { confirmed: true } : { value: text })
							}
						>
							{request.method === "confirm" ? "Confirm" : "OK"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
