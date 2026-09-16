// HTML → Markdown for `web_fetch` (spec/05-skills-and-tools.md §B.3).
//
// The spec suggests `@mozilla/readability` + `turndown`; piui ships this ~100-line converter
// instead, because the output is consumed by a model (not rendered), and because two more
// runtime dependencies on the server — one of which needs a DOM — is a bad trade for that.

const BLOCK_TAGS =
	"address|article|aside|blockquote|div|dl|dd|dt|fieldset|figcaption|figure|footer|form|header|hr|main|nav|p|section|table|tbody|td|tfoot|th|thead|tr";

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	rsquo: "’",
	lsquo: "‘",
	ldquo: "“",
	rdquo: "”",
};

export function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => codePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec: string) => codePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function codePoint(value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}

/** `<title>` of the document, when present. */
export function htmlTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match?.[1]) return undefined;
	const title = decodeEntities(match[1].replace(/\s+/g, " ")).trim();
	return title.length > 0 ? title : undefined;
}

/** A deliberately small, dependency-free HTML → Markdown conversion. */
export function htmlToMarkdown(html: string): string {
	let text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");

	// Code first: its content must survive the whitespace collapsing below.
	text = text.replace(
		/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
		(_m, inner: string) => `\n\n\`\`\`\n${stripTags(inner).trim()}\n\`\`\`\n\n`,
	);
	text = text.replace(
		/<code\b[^>]*>([\s\S]*?)<\/code>/gi,
		(_m, inner: string) => `\`${stripTags(inner).replace(/\s+/g, " ").trim()}\``,
	);

	text = text.replace(
		/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inline(inner)}\n\n`,
	);
	text = text.replace(
		/<li\b[^>]*>([\s\S]*?)<\/li>/gi,
		(_m, inner: string) => `\n- ${inline(inner)}`,
	);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(new RegExp(`</(?:${BLOCK_TAGS}|ul|ol|h[1-6])>`, "gi"), "\n\n");
	text = text.replace(new RegExp(`<(?:${BLOCK_TAGS}|ul|ol)\\b[^>]*>`, "gi"), "\n\n");

	text = inline(text);

	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\s+|\s+$/g, "");
}

/** Links, emphasis and the remaining tags, inside one block. */
function inline(fragment: string): string {
	return decodeEntities(
		fragment
			.replace(
				/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
				(_m, href: string, inner: string) => {
					const label = stripTags(inner).replace(/\s+/g, " ").trim();
					const url = href.trim();
					if (!label) return url;
					if (!url || url.startsWith("javascript:")) return label;
					return `[${label}](${url})`;
				},
			)
			.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, alt: string) =>
				alt ? `(image: ${alt})` : "",
			)
			.replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**")
			.replace(/<\/?(?:em|i)\b[^>]*>/gi, "_")
			.replace(/<[^>]+>/g, ""),
	).replace(/[ \t]+/g, " ");
}

function stripTags(fragment: string): string {
	return decodeEntities(fragment.replace(/<[^>]+>/g, ""));
}
