// Per-file setup for the unit + integration projects.
import { tmpdir } from "node:os";
import { afterEach, beforeAll } from "vitest";
import { registerTempRoot } from "../../server/test/support/temp-root-guard.js";

beforeAll(() => {
	registerTempRoot(tmpdir());
	const sandbox = process.env.PIUI_TEST_SANDBOX_HOME;
	if (!sandbox) {
		throw new Error("global setup did not run: PIUI_TEST_SANDBOX_HOME is unset");
	}
	registerTempRoot(sandbox);
});

afterEach(() => {
	// Fail fast if a test left the sandbox HOME pointing somewhere real.
	if (process.env.HOME !== process.env.PIUI_TEST_SANDBOX_HOME) {
		throw new Error("a test modified HOME; the temp-root guard can no longer protect ~/.pi");
	}
});
