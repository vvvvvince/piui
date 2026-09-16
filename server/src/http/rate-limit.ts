// Generic per-key sliding window. Used for credential mutations (spec/14-credentials.md §5:
// 20 per hour per session). The login/step-up limiter lives in auth.ts and counts failures.
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
