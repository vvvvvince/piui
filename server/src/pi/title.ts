// Auto-title: one trivial call on the conversation's model, from the first user message only
// (decision Q8, spec/07-chat-mode.md §3). Falls back to a truncated message on any failure.
import type { ModelRuntime } from "./runtime.js";

const SYSTEM =
	"Give this conversation a title of at most six words. Reply with the title only, no quotes, no punctuation at the end.";

export function fallbackTitle(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= 60) return oneLine || "New chat";
	return `${oneLine.slice(0, 57)}…`;
}

export async function generateTitle(
	runtime: ModelRuntime,
	model: unknown,
	firstMessage: string,
): Promise<string> {
	try {
		const message = await runtime.completeSimple(
			model as never,
			{
				systemPrompt: SYSTEM,
				messages: [{ role: "user", content: firstMessage, timestamp: Date.now() }],
			} as never,
		);
		const text = ((message.content ?? []) as { type: string; text?: string }[])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("")
			.trim()
			.replace(/^["']|["']$/g, "");
		return text.length > 0 ? fallbackTitle(text) : fallbackTitle(firstMessage);
	} catch {
		return fallbackTitle(firstMessage);
	}
}
