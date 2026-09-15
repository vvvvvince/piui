export function PlaceholderPage({
	title,
	milestone,
}: {
	title: string;
	milestone: string;
}): JSX.Element {
	return (
		<section>
			<h1 className="text-2xl font-semibold">{title}</h1>
			<p className="mt-2 text-sm text-slate-400">
				This page arrives in milestone {milestone}. The skeleton, routing, API client and design
				tokens are in place.
			</p>
		</section>
	);
}
