// Injected time and id generation (spec/20-development-method.md §3.3).

export interface Clock {
	now(): Date;
	nowIso(): string;
	nowMs(): number;
}

export interface IdGen {
	newId(): string;
}

export const systemClock: Clock = {
	now: () => new Date(),
	nowIso: () => new Date().toISOString(),
	nowMs: () => Date.now(),
};

export class FakeClock implements Clock {
	private ms: number;

	constructor(start: string | number | Date = "2026-01-01T00:00:00.000Z") {
		this.ms = new Date(start).getTime();
	}

	now(): Date {
		return new Date(this.ms);
	}

	nowIso(): string {
		return new Date(this.ms).toISOString();
	}

	nowMs(): number {
		return this.ms;
	}

	/** Advance the clock; the only way tests are allowed to "wait". */
	advance(ms: number): void {
		this.ms += ms;
	}

	set(at: string | number | Date): void {
		this.ms = new Date(at).getTime();
	}
}

export const systemIdGen: IdGen = {
	newId: () => crypto.randomUUID(),
};

/** Deterministic ids for tests: id-1, id-2, ... */
export class SeqIdGen implements IdGen {
	private n = 0;

	constructor(private readonly prefix = "id") {}

	newId(): string {
		this.n += 1;
		return `${this.prefix}-${this.n}`;
	}
}
