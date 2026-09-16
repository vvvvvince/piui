// spec/15-commands-and-input.md §4.3 — lists the piui key next to the pi TUI key it maps to.
const KEYS: { action: string; piui: string; pi: string; note?: string }[] = [
	{ action: "Send prompt", piui: "Enter", pi: "Enter" },
	{ action: "Newline", piui: "Shift+Enter / Ctrl+J", pi: "Shift+Enter" },
	{ action: "Steer while streaming", piui: "Enter", pi: "Enter" },
	{ action: "Queue follow-up", piui: "Alt+Enter", pi: "Alt+Enter" },
	{ action: "Interrupt (restores queue)", piui: "Esc", pi: "Esc" },
	{ action: "Dequeue", piui: "Alt+Up", pi: "Alt+Up" },
	{ action: "Collapse/expand thinking", piui: "Alt+T", pi: "Ctrl+T", note: "Ctrl+T opens a tab" },
	{ action: "Collapse/expand tool output", piui: "Alt+O", pi: "Ctrl+O" },
	{ action: "Model selector", piui: "Alt+M", pi: "Ctrl+L", note: "Ctrl+L is the address bar" },
	{ action: "Cycle model", piui: "Alt+P", pi: "Ctrl+P", note: "Ctrl+P prints" },
	{ action: "Cycle thinking level", piui: "Shift+Tab", pi: "Shift+Tab" },
	{ action: "Copy last answer", piui: "Alt+C", pi: "Ctrl+X", note: "Ctrl+X cuts" },
	{ action: "External editor", piui: "Ctrl+G", pi: "Ctrl+G" },
];

export function HotkeysDialog({ onClose }: { onClose(): void }): JSX.Element {
	return (
		<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
			<div
				role="dialog"
				aria-label="Keyboard shortcuts"
				className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-4"
			>
				<h2 className="mb-3 text-lg font-semibold">Keyboard shortcuts</h2>
				<table className="w-full text-left text-sm">
					<thead className="text-xs uppercase text-slate-500">
						<tr>
							<th className="py-1">Action</th>
							<th className="py-1">piui</th>
							<th className="py-1">pi TUI</th>
						</tr>
					</thead>
					<tbody>
						{KEYS.map((key) => (
							<tr key={key.action} className="border-t border-slate-800">
								<td className="py-1">
									{key.action}
									{key.note && <span className="ml-1 text-xs text-slate-500">({key.note})</span>}
								</td>
								<td className="py-1 font-mono text-xs">{key.piui}</td>
								<td className="py-1 font-mono text-xs text-slate-500">{key.pi}</td>
							</tr>
						))}
					</tbody>
				</table>
				<div className="mt-4 text-right">
					<button
						type="button"
						className="rounded bg-slate-700 px-3 py-1.5 text-sm"
						onClick={onClose}
					>
						Close
					</button>
				</div>
			</div>
		</div>
	);
}
