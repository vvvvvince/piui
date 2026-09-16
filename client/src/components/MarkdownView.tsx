// Model output is untrusted: sanitize always (spec/10-frontend.md §2, spec/11-security.md).
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export function MarkdownView({ text }: { text: string }): JSX.Element {
	return (
		<div className="prose prose-invert max-w-none text-sm leading-relaxed">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeSanitize]}
				components={{
					a: ({ href, children }) => (
						<a href={href} target="_blank" rel="noopener noreferrer nofollow">
							{children}
						</a>
					),
					pre: ({ children }) => (
						<pre className="overflow-x-auto rounded bg-slate-950 p-3 text-xs">{children}</pre>
					),
					table: ({ children }) => (
						<div className="overflow-x-auto">
							<table>{children}</table>
						</div>
					),
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
