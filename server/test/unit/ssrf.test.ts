// spec/11-security.md §2 (HTTP tool / web_fetch URLs) and spec/05-skills-and-tools.md §B.2/B.3.
// The guard is exercised with hostile fixtures through the injected fetch — never a real socket.
import { describe, expect, it } from "vitest";
import {
	assertUrlAllowed,
	BlockedUrlError,
	ContentTypeError,
	isPrivateAddress,
	safeFetch,
	TooManyRedirectsError,
} from "../../src/net/ssrf.js";

const lookupOf =
	(map: Record<string, string[]>) =>
	async (hostname: string): Promise<string[]> => {
		const found = map[hostname];
		if (!found) throw new Error(`ENOTFOUND ${hostname}`);
		return found;
	};

const publicLookup = lookupOf({
	"example.com": ["93.184.216.34"],
	"cdn.example.com": ["93.184.216.35"],
});

describe("SSRF guard", () => {
	it("[11-security#2] classifies loopback, private, link-local and unique-local addresses", () => {
		for (const blocked of [
			"127.0.0.1",
			"127.53.1.9",
			"0.0.0.0",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"::1",
			"fc00::1",
			"fd12:3456::1",
			"fe80::1",
			"::ffff:127.0.0.1",
			"::ffff:10.0.0.1",
		]) {
			expect(isPrivateAddress(blocked), `${blocked} must be blocked`).toBe(true);
		}
		for (const allowed of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
			expect(isPrivateAddress(allowed), `${allowed} must be allowed`).toBe(false);
		}
	});

	it("[11-security#2] allows only http(s)", async () => {
		for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]) {
			const error = await assertUrlAllowed(url, { lookup: publicLookup }).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(BlockedUrlError);
			expect((error as BlockedUrlError).reason).toBe("scheme");
		}
		await expect(
			assertUrlAllowed("https://example.com/x", { lookup: publicLookup }),
		).resolves.toBeInstanceOf(URL);
	});

	it("[11-security#2] blocks a hostname that resolves to a private address", async () => {
		const lookup = lookupOf({
			"evil.example": ["169.254.169.254"],
			"cloud.example": ["93.184.216.34", "127.0.0.1"],
		});
		const error = await assertUrlAllowed("http://evil.example/latest/meta-data", { lookup }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(BlockedUrlError);
		expect((error as BlockedUrlError).reason).toBe("private_address");
		// DNS rebinding: one public and one private answer is still a refusal
		await expect(assertUrlAllowed("http://cloud.example/", { lookup })).rejects.toBeInstanceOf(
			BlockedUrlError,
		);
	});

	it("[11-security#2] blocks a literal private address without consulting DNS", async () => {
		let calls = 0;
		const lookup = async (): Promise<string[]> => {
			calls += 1;
			return ["93.184.216.34"];
		};
		await expect(assertUrlAllowed("http://127.0.0.1:1234/", { lookup })).rejects.toBeInstanceOf(
			BlockedUrlError,
		);
		await expect(assertUrlAllowed("http://[::1]:8080/", { lookup })).rejects.toBeInstanceOf(
			BlockedUrlError,
		);
		expect(calls).toBe(0);
	});

	it("[05-skills-and-tools#B.2] allows a private address only with the env override", async () => {
		const lookup = publicLookup;
		await expect(assertUrlAllowed("http://127.0.0.1:1234/", { lookup })).rejects.toBeInstanceOf(
			BlockedUrlError,
		);
		await expect(
			assertUrlAllowed("http://127.0.0.1:1234/", { lookup, allowPrivate: true }),
		).resolves.toBeInstanceOf(URL);
	});
});

describe("safeFetch", () => {
	const ok = (body: string, contentType = "text/html; charset=utf-8"): Response =>
		new Response(body, { status: 200, headers: { "content-type": contentType } });

	const redirect = (location: string): Response =>
		new Response("", { status: 302, headers: { location } });

	it("[11-security#2] re-checks every redirect hop and refuses one that lands on a private host", async () => {
		const seen: string[] = [];
		const fetchLike = (async (input: unknown) => {
			const url = String(input);
			seen.push(url);
			if (url === "https://example.com/start") return redirect("http://169.254.169.254/latest");
			return ok("should never be reached");
		}) as unknown as typeof fetch;

		const error = await safeFetch("https://example.com/start", {
			fetch: fetchLike,
			lookup: publicLookup,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(BlockedUrlError);
		expect(seen).toEqual(["https://example.com/start"]);
	});

	it("[11-security#2] follows at most three redirects", async () => {
		let hop = 0;
		const fetchLike = (async () => {
			hop += 1;
			return redirect(`https://example.com/hop${hop}`);
		}) as unknown as typeof fetch;

		await expect(
			safeFetch("https://example.com/start", { fetch: fetchLike, lookup: publicLookup }),
		).rejects.toBeInstanceOf(TooManyRedirectsError);
		expect(hop).toBe(4);
	});

	it("[11-security#2] caps the body and reports the final URL", async () => {
		const fetchLike = (async (input: unknown) => {
			if (String(input) === "https://example.com/a") return redirect("https://cdn.example.com/b");
			return ok("x".repeat(5000), "text/plain");
		}) as unknown as typeof fetch;

		const result = await safeFetch("https://example.com/a", {
			fetch: fetchLike,
			lookup: publicLookup,
			maxBytes: 1000,
		});
		expect(result.finalUrl).toBe("https://cdn.example.com/b");
		expect(result.status).toBe(200);
		expect(result.truncated).toBe(true);
		expect(result.body.length).toBeLessThanOrEqual(1000);
	});

	it("[11-security#2] refuses a content type outside the allowlist", async () => {
		const fetchLike = (async () => ok("%PDF-1.4", "application/pdf")) as unknown as typeof fetch;
		const error = await safeFetch("https://example.com/doc.pdf", {
			fetch: fetchLike,
			lookup: publicLookup,
			allowedContentTypes: ["text/", "application/json", "application/xhtml+xml"],
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ContentTypeError);
		expect((error as Error).message).toContain("application/pdf");
	});

	it("[11-security#2] sends a browser-ish UA and an abort signal", async () => {
		let init: RequestInit | undefined;
		const fetchLike = (async (_input: unknown, i?: RequestInit) => {
			init = i;
			return ok("<p>hi</p>");
		}) as unknown as typeof fetch;

		await safeFetch("https://example.com/", {
			fetch: fetchLike,
			lookup: publicLookup,
			timeoutMs: 15_000,
		});
		const headers = new Headers(init?.headers as HeadersInit);
		expect(headers.get("user-agent")).toMatch(/Mozilla/);
		expect(init?.redirect).toBe("manual");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});
});
