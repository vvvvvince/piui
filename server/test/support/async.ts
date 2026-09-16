// Waiting on *real* asynchrony: a pi AgentSession streams on real timers, so a test that
// drives one cannot advance a FakeClock instead. Everything else in the suite must still use
// FakeClock.advance() — spec/20-development-method.md §9.1, enforced by suite-hygiene.test.ts.
export async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitUntil: condition not met in time");
		await new Promise((resolve) => {
			setTimeout(resolve, 10);
		});
	}
}
