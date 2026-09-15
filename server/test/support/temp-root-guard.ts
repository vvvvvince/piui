// Temp-root access guard — spec/20-development-method.md §9.3.
//
// Monkeypatching `node:fs` is not viable under ESM (its namespace exports are frozen, and
// direct named imports bypass any patched CJS object — verified, see plan/spikes). The guard is
// therefore built from three cheap, reliable layers:
//
//   1. `HOME` is redirected to a sandbox directory for the whole test process, so anything
//      resolving `os.homedir()` (pi's SessionManager, piui's config defaults) lands in tmpdir.
//   2. The real `~/.piui` and `~/.pi` are fingerprinted before and after the run; any creation,
//      deletion or modification fails the suite.
//   3. `assertInTempRoot()` is called by every helper that hands a path to production code.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const tempRoots = new Set<string>();

export function registerTempRoot(dir: string): void {
	tempRoots.add(resolve(dir));
}

export function isInTempRoot(path: string): boolean {
	const target = resolve(path);
	for (const root of tempRoots) {
		if (target === root || target.startsWith(`${root}/`)) return true;
	}
	return false;
}

export class TempRootViolation extends Error {
	constructor(message: string) {
		super(`temp-root guard: ${message}`);
		this.name = "TempRootViolation";
	}
}

export function assertInTempRoot(path: string, what = "path"): void {
	if (!isInTempRoot(path)) {
		throw new TempRootViolation(
			`${what} "${path}" is outside the test sandbox; tests must not touch ~/.piui, ~/.pi or any ` +
				"path outside os.tmpdir()",
		);
	}
}

export type DirFingerprint = Record<string, number> | null;

/** Recursive name+mtime fingerprint, capped so a big ~/.pi does not slow the suite down. */
export function fingerprint(dir: string, cap = 4000): DirFingerprint {
	let root: ReturnType<typeof statSync>;
	try {
		root = statSync(dir);
	} catch {
		return null;
	}
	const out: Record<string, number> = { ".": Math.floor(root.mtimeMs) };
	const stack: string[] = [dir];
	while (stack.length > 0 && Object.keys(out).length < cap) {
		const current = stack.pop()!;
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			try {
				const st = statSync(full);
				out[full.slice(dir.length + 1)] = Math.floor(st.mtimeMs);
				if (entry.isDirectory()) stack.push(full);
			} catch {
				// disappeared mid-walk; ignore
			}
		}
	}
	return out;
}

export function diffFingerprints(before: DirFingerprint, after: DirFingerprint): string[] {
	if (before === null && after === null) return [];
	if (before === null)
		return [
			`created: ${Object.keys(after ?? {})
				.slice(0, 5)
				.join(", ")}`,
		];
	if (after === null) return ["deleted entirely"];
	const problems: string[] = [];
	for (const [path, mtime] of Object.entries(after)) {
		const previous = before[path];
		if (previous === undefined) problems.push(`created ${path}`);
		else if (previous !== mtime) problems.push(`modified ${path}`);
	}
	for (const path of Object.keys(before)) {
		if (after[path] === undefined) problems.push(`deleted ${path}`);
	}
	return problems;
}
