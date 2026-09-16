// The composer's globe toggle (spec/07-chat-mode.md §3). It mirrors the conversation's
// `webSearch` field and applies from the next prompt onward, like every other mid-conversation
// change.
export interface WebSearchToggleProps {
	value: boolean;
	/** A search provider is configured on the server (`GET /api/meta`). */
	configured: boolean;
	/** Streaming: model/tool changes are refused with 409 while a run is in flight. */
	disabled: boolean;
	onChange(next: boolean): void;
}

export function WebSearchToggle({
	value,
	configured,
	disabled,
	onChange,
}: WebSearchToggleProps): JSX.Element {
	const unavailable = !configured;
	return (
		<button
			type="button"
			aria-pressed={value}
			aria-label="Web search"
			disabled={unavailable || disabled}
			title={
				unavailable
					? "No search provider is configured on this server (PIUI_SEARCH_PROVIDER)."
					: disabled
						? "Wait for the answer to finish before changing web search."
						: value
							? "Web search is on — click to turn it off"
							: "Web search is off — click to turn it on"
			}
			onClick={() => {
				if (unavailable || disabled) return;
				onChange(!value);
			}}
			className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-40 ${
				value
					? "border-sky-700 bg-sky-950/60 text-sky-200"
					: "border-slate-700 bg-slate-900 text-slate-400"
			}`}
		>
			🌐 Web search {value ? "on" : "off"}
		</button>
	);
}
