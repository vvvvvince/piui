// spec/05-skills-and-tools.md §B.3 — web_fetch converts HTML to Markdown before the model
// sees it. piui ships its own small converter instead of readability+turndown (see
// plan/milestone-notes.md, M3 deviations).
import { describe, expect, it } from "vitest";
import { htmlTitle, htmlToMarkdown } from "../../src/net/html-to-markdown.js";

describe("htmlToMarkdown", () => {
	it("[05-skills-and-tools#B.3] drops script, style and comments entirely", () => {
		const out = htmlToMarkdown(
			`<html><head><style>body{color:red}</style></head><body>
			 <script>alert("stolen")</script><!-- secret --><p>Visible text.</p></body></html>`,
		);
		expect(out).toContain("Visible text.");
		expect(out).not.toContain("alert");
		expect(out).not.toContain("color:red");
		expect(out).not.toContain("secret");
	});

	it("[05-skills-and-tools#B.3] keeps headings, lists, links and code", () => {
		const out = htmlToMarkdown(
			`<h1>Node LTS</h1><h2>Schedule</h2>
			 <ul><li>Node 24 — <a href="https://nodejs.org/en/about">active LTS</a></li><li>Node 22</li></ul>
			 <pre><code>nvm install 24</code></pre>
			 <p>Paragraph one.</p><p>Paragraph two.</p>`,
		);
		expect(out).toContain("# Node LTS");
		expect(out).toContain("## Schedule");
		expect(out).toContain("- Node 24 — [active LTS](https://nodejs.org/en/about)");
		expect(out).toContain("- Node 22");
		expect(out).toContain("```\nnvm install 24\n```");
		expect(out).toContain("Paragraph one.\n\nParagraph two.");
	});

	it("[05-skills-and-tools#B.3] decodes entities and collapses runaway whitespace", () => {
		const out = htmlToMarkdown("<p>a &amp; b &lt;tag&gt;   &nbsp;  spaced</p>\n\n\n\n<p>x</p>");
		expect(out).toContain("a & b <tag> spaced");
		expect(out).not.toMatch(/\n{3,}/);
	});

	it("[05-skills-and-tools#B.3] reads the document title when there is one", () => {
		expect(htmlTitle("<html><head><title> Node.js </title></head></html>")).toBe("Node.js");
		expect(htmlTitle("<html><body>no title</body></html>")).toBeUndefined();
	});
});
