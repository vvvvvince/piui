// The SSRF guard shared by `web_fetch` and (from M6) HTTP tools.
// spec/11-security.md §2, spec/05-skills-and-tools.md §§B.2-B.3.
//
// Everything is injected: the DNS lookup and `fetch`. The suite drives hostile fixtures
// through them, so no test ever opens a socket.
import { lookup as dnsLookup } from "node:dns/promises";
import type { FetchLike } from "../context.js";

export type LookupFn = (hostname: string) => Promise<string[]>;

export type BlockReason = "scheme" | "private_address" | "dns";

export class BlockedUrlError extends Error {
	constructor(
		readonly reason: BlockReason,
		message: string,
	) {
		super(message);
		this.name = "BlockedUrlError";
	}
}

export class TooManyRedirectsError extends Error {
	constructor(message = "too many redirects") {
		super(message);
		this.name = "TooManyRedirectsError";
	}
}

export class ContentTypeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContentTypeError";
	}
}

/** The real resolver, used in production only (tests always inject their own). */
export const systemLookup: LookupFn = async (hostname: string) => {
	const answers = await dnsLookup(hostname, { all: true, verbatim: true });
	return answers.map((a) => a.address);
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(address: string): number[] | undefined {
	const match = IPV4.exec(address);
	if (!match) return undefined;
	const octets = match.slice(1, 5).map(Number);
	return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

function isPrivateIpv4(address: string): boolean {
	const octets = ipv4Octets(address);
	if (!octets) return false;
	const [a = 0, b = 0] = octets;
	if (a === 0) return true; // "this network", and 0.0.0.0 in particular
	if (a === 10) return true;
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local incl. the cloud metadata address
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
	if (a >= 224) return true; // multicast + reserved + broadcast
	return false;
}

/** Loopback / private / link-local / unique-local, v4 and v6 (incl. v4-mapped v6). */
export function isPrivateAddress(address: string): boolean {
	const raw = address.trim().replace(/^\[|\]$/g, "");
	const scoped = raw.split("%")[0] ?? raw;
	if (isPrivateIpv4(scoped)) return true;

	const lower = scoped.toLowerCase();
	if (!lower.includes(":")) return false;
	// IPv4-mapped / -compatible: ::ffff:127.0.0.1 or ::ffff:7f00:1
	const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
	if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
	if (lower === "::" || lower === "::1") return true;
	if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
	if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link local
	if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // multicast
	return false;
}

export interface GuardOptions {
	lookup: LookupFn;
	/** PIUI_ALLOW_PRIVATE_HTTP_TOOLS=1 (spec/05-skills-and-tools.md §B.2). */
	allowPrivate?: boolean;
}

const isLiteralAddress = (host: string): boolean =>
	IPV4.test(host) || host.includes(":") || /^\[.*\]$/.test(host);

/** Throws `BlockedUrlError` unless the URL is an http(s) URL on a public address. */
export async function assertUrlAllowed(rawUrl: string, options: GuardOptions): Promise<URL> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new BlockedUrlError("scheme", `not a valid URL: ${rawUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlockedUrlError("scheme", `only http and https are allowed, got ${url.protocol}`);
	}
	if (options.allowPrivate) return url;

	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isLiteralAddress(host)) {
		if (isPrivateAddress(host)) {
			throw new BlockedUrlError("private_address", `refusing to fetch a private address: ${host}`);
		}
		return url;
	}

	let addresses: string[];
	try {
		addresses = await options.lookup(host);
	} catch (error) {
		throw new BlockedUrlError("dns", `cannot resolve ${host}: ${(error as Error).message}`);
	}
	if (addresses.length === 0) throw new BlockedUrlError("dns", `cannot resolve ${host}`);
	// One private answer is enough to refuse: DNS rebinding relies on the other one.
	const blocked = addresses.find((address) => isPrivateAddress(address));
	if (blocked) {
		throw new BlockedUrlError(
			"private_address",
			`${host} resolves to the private address ${blocked}`,
		);
	}
	return url;
}

export const BROWSERISH_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 piui";

export interface SafeFetchOptions extends GuardOptions {
	fetch: FetchLike;
	maxRedirects?: number;
	timeoutMs?: number;
	maxBytes?: number;
	/** Content-type prefixes; anything else is a `ContentTypeError`. */
	allowedContentTypes?: string[];
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface SafeFetchResult {
	finalUrl: string;
	status: number;
	contentType: string;
	body: string;
	truncated: boolean;
	redirects: number;
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

/** Guarded fetch: scheme + DNS check on every hop, redirect cap, body cap, hard timeout. */
export async function safeFetch(
	rawUrl: string,
	options: SafeFetchOptions,
): Promise<SafeFetchResult> {
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	let current = await assertUrlAllowed(rawUrl, options);
	for (let redirects = 0; ; redirects += 1) {
		const response = await options.fetch(current.toString(), {
			method: options.method ?? "GET",
			redirect: "manual",
			headers: {
				"user-agent": BROWSERISH_UA,
				accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
				...options.headers,
			},
			...(options.body === undefined ? {} : { body: options.body }),
			signal,
		});

		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			if (redirects >= maxRedirects) {
				throw new TooManyRedirectsError(`more than ${maxRedirects} redirects from ${rawUrl}`);
			}
			const next = new URL(location, current);
			// Each hop is re-checked: an open redirect must not reach a private address.
			current = await assertUrlAllowed(next.toString(), options);
			continue;
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (options.allowedContentTypes) {
			const bare = contentType.split(";")[0]!.trim().toLowerCase();
			const allowed = options.allowedContentTypes.some((prefix) => bare.startsWith(prefix));
			if (!allowed) {
				throw new ContentTypeError(
					`refusing content type ${bare || "(none)"}: only ${options.allowedContentTypes.join(", ")} can be read`,
				);
			}
		}

		const { text, truncated } = await readCapped(response, maxBytes);
		return {
			finalUrl: current.toString(),
			status: response.status,
			contentType,
			body: text,
			truncated,
			redirects,
		};
	}
}

/** Reads at most `maxBytes`, without buffering a hostile multi-GB response first. */
async function readCapped(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const body = response.body as ReadableStream<Uint8Array> | null;
	if (!body?.getReader) {
		const text = await response.text();
		return text.length > maxBytes
			? { text: text.slice(0, maxBytes), truncated: true }
			: { text, truncated: false };
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (size + value.byteLength > maxBytes) {
				chunks.push(value.subarray(0, maxBytes - size));
				truncated = true;
				break;
			}
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
