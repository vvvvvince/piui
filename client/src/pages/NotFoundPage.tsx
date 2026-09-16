// spec/10-frontend.md §4 — an unknown path is a designed state, not react-router's raw
// "Unexpected Application Error!" screen (found in the browser, M7).
import { Link } from "react-router-dom";

export function NotFoundPage(): JSX.Element {
	return (
		<div
			data-testid="not-found"
			className="mx-auto mt-16 max-w-md rounded border border-slate-800 p-6 text-center"
		>
			<h1 className="text-lg font-semibold">Page not found</h1>
			<p className="mt-1 text-sm text-slate-400">
				That address does not exist in piui. It may have been renamed, or the conversation, profile
				or skill it pointed at may have been deleted.
			</p>
			<Link to="/conversations" className="mt-4 inline-block rounded bg-sky-700 px-4 py-2 text-sm">
				Back to conversations
			</Link>
		</div>
	);
}
