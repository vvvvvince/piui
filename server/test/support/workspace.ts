// withWorkspace — a temp dir seeded with a small file tree (spec/20-development-method.md §3.2).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerTempRoot } from "./temp-root-guard.js";

export interface TempWorkspace {
	path: string;
	file(relative: string): string;
	write(relative: string, content: string): string;
	cleanup(): void;
}

const DEFAULT_TREE: Record<string, string> = {
	"README.md": "# fixture workspace\n\nUsed by piui tests.\n",
	"src/index.ts": "export const answer = 42;\n",
	"src/util/strings.ts": "export const upper = (s: string) => s.toUpperCase();\n",
	"docs/notes.md": "- a note\n",
};

export function createWorkspace(tree: Record<string, string> = DEFAULT_TREE): TempWorkspace {
	const path = mkdtempSync(join(tmpdir(), "piui-ws-"));
	registerTempRoot(path);
	const write = (relative: string, content: string): string => {
		const full = join(path, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
		return full;
	};
	for (const [relative, content] of Object.entries(tree)) write(relative, content);
	return {
		path,
		file: (relative: string) => join(path, relative),
		write,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}

export async function withWorkspace<T>(
	fn: (ws: TempWorkspace) => Promise<T> | T,
	tree?: Record<string, string>,
): Promise<T> {
	const ws = createWorkspace(tree);
	try {
		return await fn(ws);
	} finally {
		ws.cleanup();
	}
}
