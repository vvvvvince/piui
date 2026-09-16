// spec/02-data-model.md §§4-5 — transcript projection and the AgentSessionEvent -> UiEvent map,
// over the committed fixtures in server/test/fixtures (recorded with `npm run fixtures:record`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiBlock, UiEvent, UiMessage } from "@piui/shared";
import { describe, expect, it } from "vitest";
import {
	DELTA_FLUSH_BYTES,
	EventProjector,
	type ProjectedEvent,
} from "../../src/session/event-map.js";
import { MessageIds, projectTranscript, TOOL_OUTPUT_LIMIT } from "../../src/session/transcript.js";

const fixtures = join(fileURLToPath(new URL("../fixtures/", import.meta.url)));
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;

const messages = load<unknown[]>("messages.json");
const events = load<{ type: string; [key: string]: unknown }[]>("agent-events.json");

const toolBlock = (message: UiMessage | undefined): Extract<UiBlock, { type: "tool" }> => {
	const block = message?.blocks.find((b) => b.type === "tool");
	if (block?.type !== "tool") throw new Error("no tool block");
	return block;
};

describe("transcript projection", () => {
	it("[02-data-model#4.1] merges a tool call and its result into one tool block", () => {
		const projected = projectTranscript(messages, new MessageIds());
		expect(projected.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);

		const assistant = projected[1]!;
		expect(assistant.blocks.map((b) => b.type)).toEqual(["thinking", "tool"]);
		const tool = toolBlock(assistant);
		expect(tool.name).toBe("write");
		expect(tool.state).toBe("ok");
		expect(tool.output).toContain("Successfully wrote");
		expect(tool.outputTruncated).toBeUndefined();
		expect(assistant.usage).toEqual({
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.003,
		});
		expect(projected[1]!.blocks[0]).toMatchObject({ type: "thinking", collapsedByDefault: true });
	});

	it("[02-data-model#4.1] gives a stable id to the same message object and truncates huge output", () => {
		const ids = new MessageIds();
		const once = projectTranscript(messages, ids);
		const twice = projectTranscript(messages, ids);
		expect(twice.map((m) => m.id)).toEqual(once.map((m) => m.id));

		const huge = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				content: [{ type: "text", text: "x".repeat(TOOL_OUTPUT_LIMIT + 500) }],
				isError: false,
				timestamp: 2,
			},
		];
		const block = toolBlock(projectTranscript(huge, new MessageIds())[0]);
		expect(block.outputTruncated).toBe(true);
		expect(block.output!.length).toBeLessThan(TOOL_OUTPUT_LIMIT + 50);
	});

	it('[02-data-model#4.1] turns stopReason "error" into a role:"error" message', () => {
		const projected = projectTranscript(
			[{ role: "assistant", content: [], stopReason: "error", errorMessage: "402 no credit" }],
			new MessageIds(),
		);
		expect(projected[0]!.role).toBe("error");
		expect(projected[0]!.blocks[0]).toMatchObject({ type: "text", text: "402 no credit" });
	});
});

describe("event projection", () => {
	const project = (now: () => number = () => Number.MAX_SAFE_INTEGER): ProjectedEvent[] => {
		const projector = new EventProjector({ ids: new MessageIds(), now });
		const out: ProjectedEvent[] = [];
		for (const event of events) out.push(...projector.ingest(event));
		out.push(...projector.flush());
		return out;
	};

	it("[02-data-model#5.1] unwraps assistantMessageEvent deltas into block events", () => {
		const projected = project();
		const types = projected.map((e) => e.type);
		expect(types).toContain("message_start");
		expect(types).toContain("block_start");
		expect(types).toContain("block_delta");
		expect(types).toContain("block_end");
		expect(types).toContain("message_end");
		expect(types).toContain("tool_update");

		const thinking = projected.find((e) => e.type === "block_start" && e.block.type === "thinking");
		expect(thinking).toBeDefined();

		const toolUpdates = projected.filter((e) => e.type === "tool_update");
		expect(
			toolUpdates
				.map((e) => (e as { block: UiBlock }).block)
				.map((b) => (b.type === "tool" ? b.state : "?")),
		).toEqual(["running", "ok"]);
		const last = toolUpdates.at(-1) as { block: Extract<UiBlock, { type: "tool" }> };
		expect(last.block.output).toContain("Successfully wrote");
	});

	it("[02-data-model#5.1] coalesces deltas instead of emitting one frame per token", () => {
		// a clock that never advances => only the size rule can flush
		const frozen = project(() => 1000);
		const deltas = frozen.filter((e) => e.type === "block_delta");
		const chunkCount = events.filter(
			(e) =>
				e.type === "message_update" &&
				String((e.assistantMessageEvent as { type?: string })?.type).endsWith("_delta"),
		).length;
		expect(deltas.length).toBeLessThan(chunkCount);
		for (const delta of deltas) {
			const size = ((delta as { textDelta?: string }).textDelta ?? "").length;
			expect(size).toBeLessThanOrEqual(DELTA_FLUSH_BYTES + 64);
		}
		// no text is lost: the concatenated deltas equal the block's final text
		const finalText = frozen
			.filter((e) => e.type === "block_end")
			.map((e) => ((e as { block: UiBlock }).block as { text?: string }).text ?? "")
			.join("");
		const deltaText = deltas.map((d) => (d as { textDelta?: string }).textDelta ?? "").join("");
		expect(finalText).toContain(deltaText.trim().slice(0, 20));
	});

	it("[02-data-model#5.1] projects the queue and keeps unknown events silent", () => {
		const projector = new EventProjector({ ids: new MessageIds() });
		expect(projector.ingest({ type: "queue_update", steering: ["a"], followUp: ["b"] })).toEqual([
			{ type: "queue", steering: ["a"], followUp: ["b"] },
		]);
		expect(projector.ingest({ type: "bash_execution_update", delta: "x" })).toEqual([]);
	});
});

describe("UiEvent contract", () => {
	it("[02-data-model#5.1] stamps strictly increasing seq numbers", () => {
		const seqs: number[] = [];
		let seq = 0;
		for (const event of events) {
			const projector = new EventProjector({ ids: new MessageIds() });
			for (const _ of projector.ingest(event)) {
				seq += 1;
				seqs.push(seq);
			}
		}
		expect(seqs).toEqual(seqs.map((_, i) => i + 1));
		const sample: UiEvent = { type: "ping", seq: 1 };
		expect(sample.seq).toBe(1);
	});
});
