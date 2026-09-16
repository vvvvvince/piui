// spec/05-skills-and-tools.md §B.3 — the WebSearchProvider implementations, driven entirely
// through the injected fetch (no test ever touches the network).
import { describe, expect, it } from "vitest";
import {
	createSearchProvider,
	ProviderNotConfiguredError,
	SearchProviderError,
} from "../../src/search/providers.js";
import { FakeClock } from "../../src/util/clock.js";

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function recordingFetch(
	responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchLike = async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
		calls.push({ url, init });
		return await responder(url, init);
	};
	return { fetch: fetchLike as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const BRAVE_BODY = {
	web: {
		results: [
			{
				title: "Node.js releases",
				url: "https://nodejs.org/en/about/previous-releases",
				description: "Node.js 24 is the <strong>current LTS</strong>.",
				page_age: "2026-01-04T00:00:00Z",
			},
			{ title: "Second", url: "https://example.com/2", description: "Another" },
		],
	},
};

describe("web search providers", () => {
	it("[05-skills-and-tools#B.3] brave: sends the key as a header and normalizes the results", async () => {
		const clock = new FakeClock();
		const { fetch, calls } = recordingFetch(() => json(BRAVE_BODY));
		const provider = createSearchProvider({
			config: { searchProvider: "brave", searchApiKey: "brave-key", searxngUrl: undefined },
			fetch,
			nowMs: () => clock.nowMs(),
		});

		expect(provider.id).toBe("brave");
		expect(provider.configured).toBe(true);

		const results = await provider.search("latest node lts", { count: 2, freshness: "week" });

		const call = calls[0]!;
		expect(call.url).toContain("https://api.search.brave.com/res/v1/web/search");
		expect(call.url).toContain("q=latest+node+lts");
		expect(call.url).toContain("count=2");
		expect(call.url).toContain("freshness=pw");
		const headers = new Headers(call.init?.headers as HeadersInit);
		expect(headers.get("x-subscription-token")).toBe("brave-key");
		expect(headers.get("accept")).toBe("application/json");

		expect(results).toEqual([
			{
				title: "Node.js releases",
				url: "https://nodejs.org/en/about/previous-releases",
				snippet: "Node.js 24 is the current LTS.",
				publishedAt: "2026-01-04T00:00:00Z",
			},
			{ title: "Second", url: "https://example.com/2", snippet: "Another" },
		]);
	});

	it("[05-skills-and-tools#B.3] tavily: posts the key in the body and normalizes the results", async () => {
		const clock = new FakeClock();
		const { fetch, calls } = recordingFetch(() =>
			json({
				results: [
					{
						title: "Tavily hit",
						url: "https://example.com/t",
						content: "snippet text",
						published_date: "2026-02-01",
					},
				],
			}),
		);
		const provider = createSearchProvider({
			config: { searchProvider: "tavily", searchApiKey: "tvly-key", searxngUrl: undefined },
			fetch,
			nowMs: () => clock.nowMs(),
		});

		const results = await provider.search("q", { count: 3, freshness: "day" });
		const call = calls[0]!;
		expect(call.url).toBe("https://api.tavily.com/search");
		expect(call.init?.method).toBe("POST");
		expect(JSON.parse(String(call.init?.body))).toMatchObject({
			api_key: "tvly-key",
			query: "q",
			max_results: 3,
			time_range: "day",
		});
		expect(results).toEqual([
			{
				title: "Tavily hit",
				url: "https://example.com/t",
				snippet: "snippet text",
				publishedAt: "2026-02-01",
			},
		]);
		// the key must never travel in the URL, where it would land in a log
		expect(call.url).not.toContain("tvly-key");
	});

	it("[05-skills-and-tools#B.3] searxng: needs a base URL, not a key", async () => {
		const clock = new FakeClock();
		const { fetch, calls } = recordingFetch(() =>
			json({ results: [{ title: "S", url: "https://example.com/s", content: "c" }] }),
		);
		const provider = createSearchProvider({
			config: {
				searchProvider: "searxng",
				searchApiKey: undefined,
				searxngUrl: "http://searxng:8080/",
			},
			fetch,
			nowMs: () => clock.nowMs(),
		});

		expect(provider.configured).toBe(true);
		const results = await provider.search("q", {});
		expect(calls[0]!.url).toContain("http://searxng:8080/search?");
		expect(calls[0]!.url).toContain("format=json");
		expect(results[0]!.url).toBe("https://example.com/s");
	});

	it("[05-skills-and-tools#B.3] reports `none` and an unkeyed provider as not configured", async () => {
		const clock = new FakeClock();
		const { fetch, calls } = recordingFetch(() => json({}));
		for (const config of [
			{ searchProvider: "none" as const, searchApiKey: "x", searxngUrl: undefined },
			{ searchProvider: "brave" as const, searchApiKey: undefined, searxngUrl: undefined },
			{ searchProvider: "searxng" as const, searchApiKey: "x", searxngUrl: undefined },
		]) {
			const provider = createSearchProvider({ config, fetch, nowMs: () => clock.nowMs() });
			expect(provider.configured).toBe(false);
			await expect(provider.search("q", {})).rejects.toBeInstanceOf(ProviderNotConfiguredError);
		}
		expect(calls).toEqual([]);
	});

	it("[05-skills-and-tools#B.3] turns a provider HTTP error into a SearchProviderError without the key", async () => {
		const clock = new FakeClock();
		const { fetch } = recordingFetch(
			() => new Response("nope: sk-secret-123456789", { status: 401 }),
		);
		const provider = createSearchProvider({
			config: {
				searchProvider: "brave",
				searchApiKey: "sk-secret-123456789",
				searxngUrl: undefined,
			},
			fetch,
			nowMs: () => clock.nowMs(),
		});
		const error = await provider.search("q", {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as Error).message).toContain("401");
		expect((error as Error).message).not.toContain("sk-secret-123456789");
	});

	it("[05-skills-and-tools#B.3] caches by provider|query|count|freshness for 10 minutes", async () => {
		const clock = new FakeClock();
		const { fetch, calls } = recordingFetch(() => json(BRAVE_BODY));
		const provider = createSearchProvider({
			config: { searchProvider: "brave", searchApiKey: "k", searxngUrl: undefined },
			fetch,
			nowMs: () => clock.nowMs(),
		});

		await provider.search("q", { count: 5 });
		await provider.search("q", { count: 5 });
		expect(calls.length, "second identical search is served from the cache").toBe(1);

		await provider.search("q", { count: 3 });
		expect(calls.length, "a different count is a different cache key").toBe(2);

		clock.advance(10 * 60 * 1000 + 1);
		await provider.search("q", { count: 5 });
		expect(calls.length, "the entry expired after 10 minutes").toBe(3);
	});

	it("[05-skills-and-tools#B.3] clamps count to 1..10 and defaults to 5", async () => {
		const clock = new FakeClock();
		const { fetch, calls } = recordingFetch(() => json(BRAVE_BODY));
		const provider = createSearchProvider({
			config: { searchProvider: "brave", searchApiKey: "k", searxngUrl: undefined },
			fetch,
			nowMs: () => clock.nowMs(),
		});
		await provider.search("a", {});
		await provider.search("b", { count: 99 });
		await provider.search("c", { count: 0 });
		expect(calls.map((c) => new URL(c.url).searchParams.get("count"))).toEqual(["5", "10", "1"]);
	});
});
