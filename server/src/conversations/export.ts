// spec/09-api.md §8 — `GET /api/conversations/:id/export?format=md|json|html`.
//
// All three formats are rendered here. pi ships an HTML exporter but does not export it from
// the package (its `exports` map has four subpaths and none is `./dist/core/export-html`), so
// the spec's "delegate to pi's HTML export" is not reachable in 0.85.1 — see
// plan/spikes/13-export-and-compaction.md §1. Rendering from `UiMessage[]` is also the only
// representation that carries piui's own additions: tool cards, attachments, command echoes.
import type { ConversationDetail, UiBlock, UiMessage } from "@piui/shared";

export type ExportFormat = "md" | "json" | "html";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["md", "json", "html"];

export function exportFileName(conversation: { title: string; id: string }, format: ExportFormat) {
	const slug =
		(conversation.title || "conversation")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "conversation";
	return `${slug}-${conversation.id.slice(0, 8)}.${format}`;
}

const ROLE_HEADING: Record<UiMessage["role"], string> = {
	user: "User",
	assistant: "Assistant",
	system: "System",
	bash: "Shell",
	error: "Error",
};

export function renderMarkdown(conversation: ConversationDetail, messages: UiMessage[]): string {
	const lines: string[] = [
		`# ${conversation.title || "Untitled conversation"}`,
		"",
		`- Mode: ${conversation.mode}`,
		`- Model: ${conversation.model.provider}/${conversation.model.modelId}`,
		...(conversation.profile ? [`- Profile: ${conversation.profile.name}`] : []),
		...(conversation.workspace ? [`- Workspace: ${conversation.workspace.path}`] : []),
		`- Exported: ${new Date().toISOString()}`,
		"",
	];

	for (const message of messages) {
		lines.push(`## ${ROLE_HEADING[message.role] ?? message.role}`, "");
		if (message.commandEcho) {
			lines.push(`> typed: \`${message.commandEcho.typed}\``, "");
		}
		for (const block of message.blocks) lines.push(...markdownBlock(block));
		for (const attachment of message.attachments ?? []) {
			lines.push(`![${attachment.mimeType}](${attachment.url})`, "");
		}
		if (message.usage) {
			lines.push(
				`*${message.usage.input + message.usage.output} tokens · $${message.usage.cost.toFixed(4)}*`,
				"",
			);
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function markdownBlock(block: UiBlock): string[] {
	if (block.type === "text") return [block.text, ""];
	if (block.type === "thinking")
		return ["<details><summary>Thinking</summary>", "", block.text, "", "</details>", ""];
	const args = safeJson(block.args);
	const out = [`**Tool \`${block.name}\`** (${block.state})`, "", "```json", args, "```", ""];
	if (block.output) out.push("```", block.output, "```", "");
	return out;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? null, null, 2) ?? "null";
	} catch {
		return "null";
	}
}

export function renderHtml(conversation: ConversationDetail, messages: UiMessage[]): string {
	// Self-contained and asset-free: the export opens from disk with any CSP, and model output
	// is escaped rather than rendered (spec/11-security.md §2, "model output … never executed").
	const body = messages
		.map((message) => {
			const blocks = message.blocks.map(htmlBlock).join("\n");
			const attachments = (message.attachments ?? [])
				.map((a) => `<p class="attachment">${escapeHtml(a.url)}</p>`)
				.join("\n");
			const echo = message.commandEcho
				? `<p class="echo">typed: <code>${escapeHtml(message.commandEcho.typed)}</code></p>`
				: "";
			return `<section class="msg ${escapeHtml(message.role)}">
<h2>${escapeHtml(ROLE_HEADING[message.role] ?? message.role)}</h2>
${echo}${blocks}
${attachments}
</section>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(conversation.title || "Untitled conversation")}</title>
<style>
body { font: 15px/1.6 system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; color: #111; background: #fff; }
h1 { font-size: 1.4rem; } h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: #666; margin: 1.6rem 0 .4rem; }
.msg { border-top: 1px solid #e5e7eb; padding-top: .4rem; }
.msg.user h2 { color: #1d4ed8; } .msg.error h2 { color: #b91c1c; }
pre { background: #f6f7f9; padding: .6rem .8rem; overflow-x: auto; border-radius: 4px; }
.tool { font-size: .9rem; } .thinking { color: #6b7280; }
.meta { color: #6b7280; font-size: .85rem; }
</style></head>
<body>
<h1>${escapeHtml(conversation.title || "Untitled conversation")}</h1>
<p class="meta">${escapeHtml(conversation.mode)} · ${escapeHtml(conversation.model.provider)}/${escapeHtml(
		conversation.model.modelId,
	)} · exported ${escapeHtml(new Date().toISOString())}</p>
${body}
</body></html>
`;
}

function htmlBlock(block: UiBlock): string {
	if (block.type === "text") return `<p>${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
	if (block.type === "thinking") {
		return `<details class="thinking"><summary>Thinking</summary><pre>${escapeHtml(block.text)}</pre></details>`;
	}
	const output = block.output ? `<pre>${escapeHtml(block.output)}</pre>` : "";
	return `<div class="tool"><strong>${escapeHtml(block.name)}</strong> (${escapeHtml(
		block.state,
	)})<pre>${escapeHtml(safeJson(block.args))}</pre>${output}</div>`;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
