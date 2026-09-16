// Scripted fake model provider — spec/20-development-method.md §3.1, spike plan/spikes/01.
// Lives under server/src/pi/** because it imports pi types; registered only when
// config.fakeModel is true (PIUI_FAKE_MODEL=1), never in production builds.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ScriptItem =
	| { text: string }
	| { thinking: string }
	| { toolCall: { name: string; args: Record<string, unknown>; id?: string } }
	| { error: { status: number; message: string } }
	| { stall: number };

/** One script per turn: turn 0 drives the first assistant response, turn 1 the next, ... */
export type Script = ScriptItem[];

export interface FakeModelOptions {
	providerId?: string;
	modelIds?: string[];
	/** Characters per streamed delta; small on purpose so coalescing is exercised. */
	chunkSize?: number;
	/** Fixed usage so cost assertions are deterministic. */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
}

export interface FakeModelHandle {
	providerId: string;
	modelId: string;
	/** Replace the queued turns. */
	setScripts(scripts: Script[]): void;
	/** Append one more turn. */
	pushScript(script: Script): void;
	/** How many turns the provider has served. */
	get turnsServed(): number;
	/** Contexts the provider was called with (for prompt-composition assertions). */
	readonly requests: unknown[];
}

const DEFAULT_USAGE = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
const COST_PER_TURN = { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 };

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

function chunk(text: string, size: number): string[] {
	if (text.length === 0) return [""];
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

export function registerFakeProvider(
	runtime: ModelRuntime,
	options: FakeModelOptions = {},
): FakeModelHandle {
	const providerId = options.providerId ?? "piui-fake";
	const modelIds = options.modelIds ?? ["fake-1"];
	const chunkSize = options.chunkSize ?? 5;
	const usage = options.usage ?? DEFAULT_USAGE;
	const contextWindow = options.contextWindow ?? 100_000;

	let scripts: Script[] = [[{ text: "ok" }]];
	let turn = 0;
	const requests: unknown[] = [];

	const streamSimple = (model: any, context: unknown, streamOptions?: { signal?: AbortSignal }) => {
		requests.push(context);
		const signal = streamOptions?.signal;
		const script = scripts[turn] ?? [{ text: "(script exhausted)" }];
		turn += 1;
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output: any = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { ...usage, totalTokens: usage.input + usage.output, cost: { ...COST_PER_TURN } },
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			const aborted = (): boolean => signal?.aborted === true;
			const finishAborted = (): void => {
				output.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
			};
			try {
				for (const item of script) {
					if (aborted()) return finishAborted();
					if ("stall" in item) {
						await sleepUnlessAborted(item.stall, signal);
						if (aborted()) return finishAborted();
						continue;
					}
					if ("error" in item) {
						output.stopReason = "error";
						output.errorMessage = `${item.error.status}: ${item.error.message}`;
						stream.push({ type: "error", reason: "error", error: output });
						stream.end();
						return;
					}
					if ("text" in item) {
						output.content.push({ type: "text", text: "" });
						const i = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: i, partial: output });
						for (const piece of chunk(item.text, chunkSize)) {
							output.content[i].text += piece;
							stream.push({ type: "text_delta", contentIndex: i, delta: piece, partial: output });
						}
						stream.push({
							type: "text_end",
							contentIndex: i,
							content: output.content[i].text,
							partial: output,
						});
					} else if ("thinking" in item) {
						output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
						const i = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: i, partial: output });
						for (const piece of chunk(item.thinking, chunkSize)) {
							output.content[i].thinking += piece;
							stream.push({
								type: "thinking_delta",
								contentIndex: i,
								delta: piece,
								partial: output,
							});
						}
						stream.push({
							type: "thinking_end",
							contentIndex: i,
							content: output.content[i].thinking,
							partial: output,
						});
					} else {
						const toolCall = {
							type: "toolCall" as const,
							id: item.toolCall.id ?? `call_${turn}_${output.content.length}`,
							name: item.toolCall.name,
							arguments: item.toolCall.args as Record<string, any>,
						};
						output.content.push(toolCall);
						const i = output.content.length - 1;
						stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: i,
							delta: JSON.stringify(item.toolCall.args),
							partial: output,
						});
						stream.push({ type: "toolcall_end", contentIndex: i, toolCall, partial: output });
					}
				}
				output.stopReason = output.content.some((c: any) => c.type === "toolCall")
					? "toolUse"
					: "stop";
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (error) {
				output.stopReason = "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
			}
		})();
		return stream;
	};

	runtime.registerProvider(providerId, {
		name: "piui fake provider",
		baseUrl: "http://127.0.0.1:1/never-called",
		api: "openai-completions",
		// pi runs an auth preflight before streamSimple; a literal key satisfies it offline.
		apiKey: "piui-fake-key",
		streamSimple: streamSimple as never,
		models: modelIds.map((id) => ({
			id,
			name: `Fake ${id}`,
			reasoning: true,
			// The fake model is vision-capable so the attach-image path is exercisable offline.
			input: ["text" as const, "image" as const],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: 4096,
		})),
	});

	return {
		providerId,
		modelId: modelIds[0]!,
		setScripts(next) {
			scripts = next;
			turn = 0;
		},
		pushScript(script) {
			scripts.push(script);
		},
		get turnsServed() {
			return turn;
		},
		requests,
	};
}
