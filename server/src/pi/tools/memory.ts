// `memory_append` — the only path by which an agent may write to a profile's memory
// (spec/03-profiles.md §5.3, spec/17-memory.md §6 guarantee 1). Never destructive.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_NOTE_MAX_CHARS, type MemoryStore } from "../../profiles/memory.js";
import type { PiTool } from "./web-search.js";

export interface MemoryToolDeps {
	profileId: string;
	profileName: string;
	path: string;
	store: MemoryStore;
	nowIso(): string;
	/** Every successful append is visible in the transcript (§5.3, last bullet). */
	onNotice(text: string): void;
}

export function createMemoryTool(deps: MemoryToolDeps): PiTool {
	return defineTool({
		name: "memory_append",
		label: "Remember",
		description:
			"Append a durable note to your persistent memory for this profile. Use for stable facts, " +
			"user preferences, project conventions and lessons learned. Do not store secrets, " +
			"long file contents, or transient task state.",
		parameters: Type.Object({
			note: Type.String({ description: "One or a few sentences, self-contained." }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Short topic tags." })),
		}),
		async execute(_toolCallId, params) {
			const note = params.note.trim();
			if (note.length > MEMORY_NOTE_MAX_CHARS) {
				throw new Error(
					`That note is ${note.length} characters; keep it under ${MEMORY_NOTE_MAX_CHARS}. Be concise.`,
				);
			}
			const outcome = await deps.store.append(deps.profileId, {
				path: deps.path,
				profileName: deps.profileName,
				note,
				...(params.tags ? { tags: params.tags } : {}),
				// The file format pins seconds precision (spec/17-memory.md §2).
				timestamp: `${deps.nowIso().slice(0, 19)}Z`,
			});

			type Details = { line?: string; sizeBytes?: number };
			switch (outcome.status) {
				case "duplicate":
					return {
						content: [{ type: "text" as const, text: "already remembered" }],
						details: {} as Details,
					};
				case "too_long":
					throw new Error(`Keep the note under ${MEMORY_NOTE_MAX_CHARS} characters. Be concise.`);
				case "file_full":
					throw new Error(
						"The memory file is larger than 1 MB; ask the user to curate it before saving more.",
					);
				default: {
					deps.onNotice(`Remembered: ${note}`);
					return {
						content: [{ type: "text" as const, text: `Remembered: ${note}` }],
						details: { line: outcome.line, sizeBytes: outcome.sizeBytes } as Details,
					};
				}
			}
		},
	}) as unknown as PiTool;
}
