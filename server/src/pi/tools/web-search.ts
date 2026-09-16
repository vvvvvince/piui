// `web_search` and `web_fetch` as pi custom tools (spec/05-skills-and-tools.md §B.3,
// spike plan/spikes/08). Both take an injectable `fetch` — that seam is the whole reason the
// SSRF and provider tests can run offline.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FetchLike } from "../../context.js";
import { htmlTitle, htmlToMarkdown } from "../../net/html-to-markdown.js";
import {
	BlockedUrlError,
	ContentTypeError,
	type LookupFn,
	safeFetch,
	systemLookup,
	TooManyRedirectsError,
} from "../../net/ssrf.js";
import { ProviderNotConfiguredError, type WebSearchProvider } from "../../search/providers.js";

/** The structural slice of pi's `ToolDefinition` the rest of piui needs (tests included). */
export interface PiTool {
	name: string;
	label: string;
	description: string;
	execute(
		toolCallId: string,
		params: never,
		signal: AbortSignal | undefined,
		onUpdate: never,
		ctx: never,
	): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export const MAX_SEARCHES_PER_RUN = 10;
export const WEB_FETCH_DEFAULT_CHARS = 20_000;
export const WEB_FETCH_MAX_CHARS = 100_000;
const WEB_FETCH_TIMEOUT_MS = 15_000;
const FETCHABLE_CONTENT_TYPES = [
	"text/",
	"application/json",
	"application/xhtml+xml",
	"application/xml",
];

export interface WebToolsDeps {
	provider: WebSearchProvider;
	fetch: FetchLike;
	lookup?: LookupFn;
	/** PIUI_ALLOW_PRIVATE_HTTP_TOOLS=1 — the escape hatch of §B.2. */
	allowPrivate?: boolean;
	maxSearchesPerRun?: number;
}

export interface WebToolSet {
	names: string[];
	tools: PiTool[];
	/** Resets the per-run search budget (called on `agent_start`). */
	beginRun(): void;
	/** Searches spent in the current run — asserted by the rate-limit test. */
	readonly searchesThisRun: number;
}

export function createWebTools(deps: WebToolsDeps): WebToolSet {
	const lookup = deps.lookup ?? systemLookup;
	const budget = deps.maxSearchesPerRun ?? MAX_SEARCHES_PER_RUN;
	let spent = 0;

	const webSearch = defineTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web and return the top results as a numbered list of titles, snippets and URLs. " +
			"Use it for current events, versions, prices, documentation, or anything your knowledge may be stale about.",
		parameters: Type.Object({
			query: Type.String({ description: "What to search for.", minLength: 1 }),
			count: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 10, description: "How many results (default 5)." }),
			),
			freshness: Type.Optional(
				Type.Union([
					Type.Literal("day"),
					Type.Literal("week"),
					Type.Literal("month"),
					Type.Literal("year"),
				]),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			if (spent >= budget) {
				throw new Error(
					`Web search limit reached (${budget} searches in this run). Synthesize an answer from what you already have, and say what is still uncertain.`,
				);
			}
			spent += 1;
			onUpdate?.({
				content: [{ type: "text", text: `Searching the web for “${params.query}”…` }],
				details: { query: params.query, provider: deps.provider.id, results: [] },
			});

			let results: Awaited<ReturnType<WebSearchProvider["search"]>>;
			try {
				results = await deps.provider.search(params.query, {
					...(params.count === undefined ? {} : { count: params.count }),
					...(params.freshness === undefined ? {} : { freshness: params.freshness }),
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				if (error instanceof ProviderNotConfiguredError) {
					throw new Error("Web search is not configured on this server.");
				}
				throw new Error(`Web search failed: ${(error as Error).message}`);
			}

			const lines = results.map(
				(result, index) =>
					`${index + 1}. **${result.title}** — ${result.snippet}${
						result.publishedAt ? ` (${result.publishedAt})` : ""
					}\n   ${result.url}`,
			);
			const text =
				results.length === 0
					? `No results for “${params.query}”. Try different words, or answer from what you know and say it is unverified.`
					: `${lines.join("\n")}\n\nUse web_fetch on a URL to read the full page.`;

			return {
				content: [{ type: "text" as const, text }],
				details: { provider: deps.provider.id, query: params.query, results },
			};
		},
	});

	const webFetch = defineTool({
		name: "web_fetch",
		label: "Fetch web page",
		description:
			"Fetch one http(s) URL and return its readable text as Markdown. Use it to read a page found with web_search.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL." }),
			maxChars: Type.Optional(
				Type.Integer({
					minimum: 500,
					maximum: WEB_FETCH_MAX_CHARS,
					description: `Characters to keep (default ${WEB_FETCH_DEFAULT_CHARS}).`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const maxChars = Math.min(
				WEB_FETCH_MAX_CHARS,
				Math.max(500, params.maxChars ?? WEB_FETCH_DEFAULT_CHARS),
			);
			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${params.url}…` }],
				details: { url: params.url },
			});

			let response: Awaited<ReturnType<typeof safeFetch>>;
			try {
				response = await safeFetch(params.url, {
					fetch: deps.fetch,
					lookup,
					...(deps.allowPrivate === undefined ? {} : { allowPrivate: deps.allowPrivate }),
					timeoutMs: WEB_FETCH_TIMEOUT_MS,
					maxBytes: 2 * 1024 * 1024,
					allowedContentTypes: FETCHABLE_CONTENT_TYPES,
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				throw new Error(fetchErrorMessage(params.url, error));
			}

			if (response.status >= 400) {
				throw new Error(
					`${params.url} answered ${response.status}. ${response.body.slice(0, 300)}`.trim(),
				);
			}

			const bare = response.contentType.split(";")[0]!.trim().toLowerCase();
			const isHtml = bare === "text/html" || bare === "application/xhtml+xml";
			const converted = isHtml ? htmlToMarkdown(response.body) : response.body.trim();
			const title = isHtml ? htmlTitle(response.body) : undefined;
			const truncated = converted.length > maxChars;
			const text = truncated
				? `${converted.slice(0, maxChars)}\n\n…[truncated, ${converted.length - maxChars} chars omitted]`
				: converted;

			return {
				content: [{ type: "text" as const, text }],
				details: {
					url: params.url,
					finalUrl: response.finalUrl,
					status: response.status,
					contentType: response.contentType,
					chars: text.length,
					...(title ? { title } : {}),
				},
			};
		},
	});

	return {
		names: ["web_search", "web_fetch"],
		tools: [webSearch as unknown as PiTool, webFetch as unknown as PiTool],
		beginRun() {
			spent = 0;
		},
		get searchesThisRun() {
			return spent;
		},
	};
}

function fetchErrorMessage(url: string, error: unknown): string {
	if (error instanceof BlockedUrlError) {
		return error.reason === "scheme"
			? `Refusing to fetch ${url}: only http and https URLs can be fetched.`
			: `Refusing to fetch ${url}: ${error.message}.`;
	}
	if (error instanceof TooManyRedirectsError) return `${url} redirected too many times.`;
	if (error instanceof ContentTypeError) return `Cannot read ${url}: ${error.message}.`;
	const message = (error as Error).message ?? String(error);
	if (/abort|timeout/i.test(message)) return `Fetching ${url} timed out.`;
	return `Fetching ${url} failed: ${message}`;
}
