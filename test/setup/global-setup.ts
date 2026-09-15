// Vitest globalSetup: sandbox HOME + fingerprint the developer's real pi/piui directories.
// spec/20-development-method.md §9.3.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type DirFingerprint,
	diffFingerprints,
	fingerprint,
} from "../../server/test/support/temp-root-guard.js";

let sandbox: string;
const watched = [".piui", ".pi"];
export const CREDENTIAL_ENV =
	/^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|GROQ|MISTRAL|XAI|OPENROUTER|TOGETHER|CEREBRAS|DEEPSEEK|AZURE|AWS|BEDROCK|ZAI)_.*(KEY|TOKEN|SECRET|CREDENTIALS)$|_API_KEY$/;
const before = new Map<string, DirFingerprint>();

export async function setup(): Promise<void> {
	const realHome = homedir();
	for (const name of watched) {
		before.set(name, fingerprint(resolve(realHome, name)));
	}
	// The suite must run with no credentials configured (spec/20-development-method.md §9.1).
	for (const key of Object.keys(process.env)) {
		if (CREDENTIAL_ENV.test(key)) delete process.env[key];
	}

	sandbox = mkdtempSync(join(tmpdir(), "piui-sandbox-home-"));
	process.env.PIUI_TEST_SANDBOX_HOME = sandbox;
	process.env.PIUI_TEST_REAL_HOME = realHome;
	process.env.HOME = sandbox;
	process.env.USERPROFILE = sandbox;
}

export async function teardown(): Promise<void> {
	const realHome = process.env.PIUI_TEST_REAL_HOME ?? homedir();
	const problems: string[] = [];
	for (const name of watched) {
		const diff = diffFingerprints(before.get(name) ?? null, fingerprint(resolve(realHome, name)));
		if (diff.length > 0) problems.push(`~/${name}: ${diff.slice(0, 10).join("; ")}`);
	}
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	if (problems.length > 0) {
		throw new Error(
			`temp-root guard: the test run touched the developer's real home directories:\n  ${problems.join("\n  ")}`,
		);
	}
}
