// Web search providers. spec/05-skills-and-tools.md §B.3.
// Every implementation talks to the world through the injected `fetch`, which is what makes
// the suite offline-by-construction (spec/20-development-method.md §3.3).
import type { SearchProviderId } from "../config.js";
import type { FetchLike } from "../context.js";

export type Freshness = "day" | "week" | "month" | "year";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
}

export interface SearchOptions {
	count?: number;
	freshness?: Freshness;
	signal?: AbortSignal;
}

export interface WebSearchProvider {
	readonly id: SearchProviderId;
	/** A key (or, for searxng, a base URL) is present. */
	readonly configured: boolean;
	search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

/** The provider is `none`, or its key/URL is missing → `provider_not_configured`. */
export class ProviderNotConfiguredError extends Error {
	constructor(message = "Web search is not configured on this server.") {
		super(message);
		this.name = "ProviderNotConfiguredError";
	}
}

/** The provider answered, but not with results. Never carries the key or the response body. */
export class SearchProviderError extends Error {
	/** The upstream body, for the server log only — never for a client or a model. */
	readonly detail: string | undefined;

	constructor(message: string, detail?: string) {
		super(message);
		this.name = "SearchProviderError";
		this.detail = detail;
	}
}

export interface SearchProviderDeps {
	config: {
		searchProvider: SearchProviderId;
		searchApiKey: string | undefined;
		searxngUrl: string | undefined;
	};
	fetch: FetchLike;
	nowMs(): number;
	/** Per-request timeout; the provider is not allowed to hang a tool call. */
	timeoutMs?: number;
}

export const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
export const SEARCH_CACHE_MAX_ENTRIES = 200;
const DEFAULT_COUNT = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

const clampCount = (count: number | undefined): number => {
	if (count === undefined || !Number.isFinite(count)) return DEFAULT_COUNT;
	return Math.min(10, Math.max(1, Math.trunc(count)));
};

/** Search snippets are provider HTML; the model gets text, and the UI never renders them raw. */
function stripTags(text: string): string {
	return text
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function scrub(text: string, secret: string | undefined): string {
	let out = text.replace(/\b(sk|tvly|brv|pat|api)[-_][A-Za-z0-9_-]{6,}/g, "***");
	if (secret && secret.length >= 4) out = out.split(secret).join("***");
	return out;
}

interface RawProvider {
	id: SearchProviderId;
	configured: boolean;
	run(
		query: string,
		count: number,
		freshness: Freshness | undefined,
		signal: AbortSignal | undefined,
	): Promise<SearchResult[]>;
}

const BRAVE_FRESHNESS: Record<Freshness, string> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

function braveProvider(deps: SearchProviderDeps): RawProvider {
	const key = deps.config.searchApiKey;
	return {
		id: "brave",
		configured: Boolean(key),
		async run(query, count, freshness, signal) {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(count));
			if (freshness) url.searchParams.set("freshness", BRAVE_FRESHNESS[freshness]);
			const body = await readJson(deps, url.toString(), {
				headers: { accept: "application/json", "x-subscription-token": key ?? "" },
				...(signal ? { signal } : {}),
			});
			const results = (body as { web?: { results?: unknown[] } }).web?.results ?? [];
			return results.map((raw) => {
				const item = raw as {
					title?: string;
					url?: string;
					description?: string;
					page_age?: string;
				};
				return {
					title: stripTags(item.title ?? item.url ?? ""),
					url: item.url ?? "",
					snippet: stripTags(item.description ?? ""),
					...(item.page_age ? { publishedAt: item.page_age } : {}),
				};
			});
		},
	};
}

function tavilyProvider(deps: SearchProviderDeps): RawProvider {
	const key = deps.config.searchApiKey;
	return {
		id: "tavily",
		configured: Boolean(key),
		async run(query, count, freshness, signal) {
			const body = await readJson(deps, "https://api.tavily.com/search", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({
					api_key: key,
					query,
					max_results: count,
					search_depth: "basic",
					...(freshness ? { time_range: freshness } : {}),
				}),
				...(signal ? { signal } : {}),
			});
			const results = (body as { results?: unknown[] }).results ?? [];
			return results.map((raw) => {
				const item = raw as {
					title?: string;
					url?: string;
					content?: string;
					published_date?: string;
				};
				return {
					title: stripTags(item.title ?? item.url ?? ""),
					url: item.url ?? "",
					snippet: stripTags(item.content ?? ""),
					...(item.published_date ? { publishedAt: item.published_date } : {}),
				};
			});
		},
	};
}

function searxngProvider(deps: SearchProviderDeps): RawProvider {
	const base = deps.config.searxngUrl;
	return {
		id: "searxng",
		configured: Boolean(base),
		async run(query, count, freshness, signal) {
			const url = new URL("search", base?.endsWith("/") ? base : `${base ?? ""}/`);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			if (freshness) url.searchParams.set("time_range", freshness);
			const body = await readJson(deps, url.toString(), {
				headers: { accept: "application/json" },
				...(signal ? { signal } : {}),
			});
			const results = (body as { results?: unknown[] }).results ?? [];
			return results.slice(0, count).map((raw) => {
				const item = raw as {
					title?: string;
					url?: string;
					content?: string;
					publishedDate?: string;
				};
				return {
					title: stripTags(item.title ?? item.url ?? ""),
					url: item.url ?? "",
					snippet: stripTags(item.content ?? ""),
					...(item.publishedDate ? { publishedAt: item.publishedDate } : {}),
				};
			});
		},
	};
}

async function readJson(
	deps: SearchProviderDeps,
	url: string,
	init: RequestInit,
): Promise<unknown> {
	let response: Response;
	const signal = init.signal ?? AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		response = await deps.fetch(url, { ...init, signal, redirect: "follow" });
	} catch (error) {
		throw new SearchProviderError(
			scrub(`search request failed: ${(error as Error).message}`, deps.config.searchApiKey),
		);
	}
	if (!response.ok) {
		// The body is the *provider's* error page: it is logged, never returned to the client
		// (spec/11-security.md §8). Found in the container, where SearXNG without
		// `formats: [json]` answers 403 with an HTML page piui used to echo back verbatim.
		const snippet = scrub(
			(await response.text().catch(() => "")).slice(0, 200),
			deps.config.searchApiKey,
		);
		throw new SearchProviderError(`search provider answered ${response.status}`, snippet);
	}
	try {
		return await response.json();
	} catch (error) {
		throw new SearchProviderError(
			scrub(
				`search provider returned invalid JSON: ${(error as Error).message}`,
				deps.config.searchApiKey,
			),
		);
	}
}

interface CacheEntry {
	at: number;
	results: SearchResult[];
}

/** Provider + the LRU response cache of §B.3 (key `provider|query|count|freshness`). */
class CachingSearchProvider implements WebSearchProvider {
	private readonly cache = new Map<string, CacheEntry>();

	constructor(
		private readonly raw: RawProvider,
		private readonly nowMs: () => number,
	) {}

	get id(): SearchProviderId {
		return this.raw.id;
	}

	get configured(): boolean {
		return this.raw.configured;
	}

	async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
		if (!this.configured) throw new ProviderNotConfiguredError();
		const count = clampCount(options.count);
		const key = `${this.raw.id}|${query}|${count}|${options.freshness ?? ""}`;
		const hit = this.cache.get(key);
		const now = this.nowMs();
		if (hit && now - hit.at <= SEARCH_CACHE_TTL_MS) {
			// refresh LRU position
			this.cache.delete(key);
			this.cache.set(key, hit);
			return hit.results;
		}
		const results = await this.raw.run(query, count, options.freshness, options.signal);
		this.cache.set(key, { at: now, results });
		while (this.cache.size > SEARCH_CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			this.cache.delete(oldest.value);
		}
		return results;
	}
}

class NoSearchProvider implements WebSearchProvider {
	readonly id: SearchProviderId = "none";
	readonly configured = false;
	async search(): Promise<SearchResult[]> {
		throw new ProviderNotConfiguredError();
	}
}

export function createSearchProvider(deps: SearchProviderDeps): WebSearchProvider {
	switch (deps.config.searchProvider) {
		case "brave":
			return new CachingSearchProvider(braveProvider(deps), deps.nowMs);
		case "tavily":
			return new CachingSearchProvider(tavilyProvider(deps), deps.nowMs);
		case "searxng":
			return new CachingSearchProvider(searxngProvider(deps), deps.nowMs);
		default:
			return new NoSearchProvider();
	}
}
