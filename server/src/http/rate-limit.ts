// Generic per-key sliding window. Used for credential mutations (spec/14-credentials.md §5:
// 20 per hour per session) and for the route limits of spec/11-security.md §4.
// The login/step-up limiter lives in auth.ts and counts failures.
export class SlidingWindowLimiter {
	private readonly hits = new Map<string, number[]>();

	constructor(
		private readonly nowMs: () => number,
		readonly limit: number,
		readonly windowMs: number,
	) {}

	/** Records the hit and reports whether it is allowed. */
	take(key: string): boolean {
		const window = this.prune(key);
		if (window.length >= this.limit) return false;
		window.push(this.nowMs());
		this.hits.set(key, window);
		return true;
	}

	private prune(key: string): number[] {
		const cutoff = this.nowMs() - this.windowMs;
		const window = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
		if (window.length === 0) this.hits.delete(key);
		else this.hits.set(key, window);
		return window;
	}
}

/** spec/11-security.md §4, last bullet. Login lives in auth.ts; `web_search` is a per-run budget. */
const ROUTE_LIMITS: { match(method: string, path: string): boolean; limit: number }[] = [
	{
		match: (method, path) =>
			method === "POST" && /^\/api\/conversations\/[^/]+\/messages$/.test(path),
		limit: 60,
	},
	{ match: (method, path) => method === "GET" && path === "/api/fs/browse", limit: 120 },
];

/** One limiter per rule, keyed by session id: a busy tab cannot starve another user. */
export class RouteRateLimiter {
	private readonly limiters: SlidingWindowLimiter[];

	constructor(nowMs: () => number) {
		this.limiters = ROUTE_LIMITS.map((rule) => new SlidingWindowLimiter(nowMs, rule.limit, 60_000));
	}

	/** False when this request must be refused with `429 rate_limited`. */
	take(method: string, url: string, key: string): boolean {
		const path = url.split("?")[0]!;
		for (const [index, rule] of ROUTE_LIMITS.entries()) {
			if (rule.match(method, path)) return this.limiters[index]!.take(key);
		}
		return true;
	}
}
