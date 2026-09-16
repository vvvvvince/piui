// spec/05-skills-and-tools.md §B.3 — the `web_search` / `web_fetch` custom tools.
// Both run entirely on injected seams: the search provider's fetch, and web_fetch's fetch +
// DNS lookup. Nothing here touches the network.
import { describe, expect, it } from "vitest";
import { createWebTools, type PiTool } from "../../src/pi/tools/web-search.js";
import { createSearchProvider, type WebSearchProvider } from "../../src/search/providers.js";
import { FakeClock } from "../../src/util/clock.js";

const lookup = async (hostname: string): Promise<string[]> =>
	hostname === "nodejs.org" || hostname === "example.com" ? ["93.184.216.34"] : ["93.184.216.35"];

function toolsOf(deps: Parameters<typeof createWebTools>[0]) {
	const set = createWebTools(deps);
	const byName = new Map(set.tools.map((tool) => [tool.name, tool as PiTool]));
	return {
		set,
		search: byName.get("web_search")!,
		fetchTool: byName.get("web_fetch")!,
	};
}

const run = (tool: PiTool, params: unknown, onUpdate?: (partial: unknown) => void) =>
	tool.execute("call-1", params as never, undefined, onUpdate as never, {} as never);

function stubProvider(overrides: Partial<WebSearchProvider> = {}): WebSearchProvider {
	return {
		id: "brave",
		configured: true,
		search: async () => [
			{
				title: "Node.js releases",
				url: "https://nodejs.org/en/about/previous-releases",
				snippet: "Node 24 is the active LTS.",
				publishedAt: "2026-01-04",
			},
			{ title: "Second hit", url: "https://example.com/2", snippet: "More." },
		],
		...overrides,
	} as WebSearchProvider;
}

const html = (body: string): Response =>
	new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

describe("web_search tool", () => {
	it("[05-skills-and-tools#B.3] renders a numbered Markdown list with the web_fetch hint", async () => {
		const { search } = toolsOf({ provider: stubProvider(), fetch: failFetch(), lookup });
		const result = await run(search, { query: "latest node lts" });
		const text = String(result.content[0]?.text);

		expect(text).toContain("1. **Node.js releases** — Node 24 is the active LTS.");
		expect(text).toContain("   https://nodejs.org/en/about/previous-releases");
		expect(text).toContain("2. **Second hit** — More.");
		expect(text.trimEnd().endsWith("Use web_fetch on a URL to read the full page.")).toBe(true);
		expect(result.details).toMatchObject({
			provider: "brave",
			query: "latest node lts",
			results: [
				{ title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases" },
				{ title: "Second hit", url: "https://example.com/2" },
			],
		});
	});

	it("[05-skills-and-tools#B.3] streams a progress update so the card is not frozen", async () => {
		const { search } = toolsOf({ provider: stubProvider(), fetch: failFetch(), lookup });
		const updates: unknown[] = [];
		await run(search, { query: "q" }, (partial) => updates.push(partial));
		expect(updates.length).toBeGreaterThan(0);
		expect(String((updates[0] as { content: { text: string }[] }).content[0]?.text)).toMatch(
			/search/i,
		);
	});

	it("[05-skills-and-tools#B.3] answers 'not configured' as a tool error, never a crash", async () => {
		const clock = new FakeClock();
		const provider = createSearchProvider({
			config: { searchProvider: "none", searchApiKey: undefined, searxngUrl: undefined },
			fetch: failFetch(),
			nowMs: () => clock.nowMs(),
		});
		const { search } = toolsOf({ provider, fetch: failFetch(), lookup });
		await expect(run(search, { query: "q" })).rejects.toThrow(
			"Web search is not configured on this server.",
		);
	});

	it("[05-skills-and-tools#B.3] allows 10 searches per run and then tells the model to synthesize", async () => {
		let searches = 0;
		const provider = stubProvider({
			search: async () => {
				searches += 1;
				return [];
			},
		});
		const { set, search } = toolsOf({ provider, fetch: failFetch(), lookup });
		for (let i = 0; i < 10; i += 1) await run(search, { query: `q${i}` });
		await expect(run(search, { query: "q10" })).rejects.toThrow(/synthes/i);
		expect(searches).toBe(10);

		// a new run starts with a fresh budget
		set.beginRun();
		await run(search, { query: "again" });
		expect(searches).toBe(11);
	});

	it("[05-skills-and-tools#B.3] says so plainly when there are no results", async () => {
		const { search } = toolsOf({
			provider: stubProvider({ search: async () => [] }),
			fetch: failFetch(),
			lookup,
		});
		const result = await run(search, { query: "nothing at all" });
		expect(String(result.content[0]?.text)).toMatch(/no results/i);
	});
});

describe("web_fetch tool", () => {
	it("[05-skills-and-tools#B.3] converts HTML to Markdown and reports details", async () => {
		const fetchLike = (async () =>
			html(
				"<html><head><title>Releases</title></head><body><h1>Node</h1><p>LTS is 24.</p></body></html>",
			)) as unknown as typeof fetch;
		const { fetchTool } = toolsOf({ provider: stubProvider(), fetch: fetchLike, lookup });

		const result = await run(fetchTool, { url: "https://nodejs.org/en/about" });
		const text = String(result.content[0]?.text);
		expect(text).toContain("# Node");
		expect(text).toContain("LTS is 24.");
		expect(result.details).toMatchObject({
			url: "https://nodejs.org/en/about",
			finalUrl: "https://nodejs.org/en/about",
			status: 200,
			contentType: "text/html; charset=utf-8",
		});
		expect((result.details as { chars: number }).chars).toBe(text.length);
	});

	it("[05-skills-and-tools#B.3] truncates at maxChars with an explicit note", async () => {
		const fetchLike = (async () =>
			html(`<p>${"word ".repeat(2000)}</p>`)) as unknown as typeof fetch;
		const { fetchTool } = toolsOf({ provider: stubProvider(), fetch: fetchLike, lookup });

		const result = await run(fetchTool, { url: "https://example.com/long", maxChars: 200 });
		const text = String(result.content[0]?.text);
		expect(text).toMatch(/…\[truncated, \d+ chars omitted]$/);
	});

	it("[11-security#2] refuses a private address (the SSRF guard is shared)", async () => {
		const { fetchTool } = toolsOf({ provider: stubProvider(), fetch: failFetch(), lookup });
		await expect(run(fetchTool, { url: "http://127.0.0.1:1234/admin" })).rejects.toThrow(
			/private address/i,
		);
		await expect(run(fetchTool, { url: "file:///etc/hostname" })).rejects.toThrow(/http/i);
	});

	it("[05-skills-and-tools#B.3] refuses a binary content type with a clear message", async () => {
		const fetchLike = (async () =>
			new Response("%PDF", {
				status: 200,
				headers: { "content-type": "application/pdf" },
			})) as unknown as typeof fetch;
		const { fetchTool } = toolsOf({ provider: stubProvider(), fetch: fetchLike, lookup });
		await expect(run(fetchTool, { url: "https://example.com/a.pdf" })).rejects.toThrow(
			/application\/pdf/,
		);
	});

	it("[05-skills-and-tools#B.3] passes JSON through untouched", async () => {
		const fetchLike = (async () =>
			new Response('{"lts":24}', {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		const { fetchTool } = toolsOf({ provider: stubProvider(), fetch: fetchLike, lookup });
		const result = await run(fetchTool, { url: "https://example.com/api" });
		expect(String(result.content[0]?.text)).toContain('{"lts":24}');
	});
});

function failFetch(): typeof fetch {
	return (() => {
		throw new Error("no test may perform real network I/O — inject a fetch");
	}) as unknown as typeof fetch;
}
