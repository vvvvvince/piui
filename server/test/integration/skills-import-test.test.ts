// spec/05-skills-and-tools.md §A.4 — import (zip / path / paste) and the ephemeral test run.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type {
	ConversationsResponse,
	SkillSummary,
	SkillTestResponse,
	UiMessage,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { EPHEMERAL_TTL_MS } from "../../src/skills/test-run.js";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";

const json = { "content-type": "application/json" };
const DESCRIPTION = "Extract text and tables from PDF files. Use when working with PDF documents.";
const SKILL = `---\nname: zipped\ndescription: ${DESCRIPTION}\n---\n\n# Zipped\n\nBody.\n`;

/** Minimal zip writer (the same one the unit test uses), so no dependency is needed. */
function buildZip(entries: { name: string; content: string }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.from(entry.content, "utf8");
		const data = deflateRawSync(raw);
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		locals.push(local, data);
		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centrals.push(central);
		offset += local.length + data.length;
	}
	const centralBuf = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBuf, end]);
}

function multipart(zip: Buffer): { headers: Record<string, string>; payload: Buffer } {
	const boundary = "----piuitest";
	const head = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\n` +
			"Content-Type: application/zip\r\n\r\n",
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
	return {
		headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
		payload: Buffer.concat([head, zip, tail]),
	};
}

const importZip = async (t: TestApp, me: MintedPrincipal, zip: Buffer) => {
	const { headers, payload } = multipart(zip);
	return t.app.inject({
		method: "POST",
		url: "/api/skills/import-zip",
		headers: { ...me.headers, ...headers },
		payload,
	});
};

describe("skill import", () => {
	it("[05-skills-and-tools#A.4] imports a zip archive into a managed skill directory", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const res = await importZip(
				t,
				me,
				buildZip([
					{ name: "zipped/SKILL.md", content: SKILL },
					{ name: "zipped/references/api.md", content: "# API\n" },
				]),
			);
			expect(res.statusCode).toBe(201);
			const created = res.json<SkillSummary>();
			expect(created.name).toBe("zipped");
			expect(existsSync(join(t.home, "skills", "zipped", "references", "api.md"))).toBe(true);
		});
	});

	it("[11-security#3] refuses a zip whose entry escapes the skill directory and writes nothing", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const res = await importZip(
				t,
				me,
				buildZip([
					{ name: "zipped/SKILL.md", content: SKILL },
					{ name: "zipped/../../escape.md", content: "pwned" },
				]),
			);
			expect(res.statusCode).toBe(400);
			expect(res.json<{ error: { code: string } }>().error.code).toBe("path_escape");
			expect(existsSync(join(t.home, "skills", "zipped"))).toBe(false);
			expect(existsSync(join(t.home, "escape.md"))).toBe(false);
			expect(existsSync(join(t.home, "skills", "escape.md"))).toBe(false);
		});
	});

	it("[05-skills-and-tools#A.4] imports a pasted SKILL.md and registers an external directory", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const pasted = await t.app.inject({
				method: "POST",
				url: "/api/skills/import",
				headers: { ...me.headers, ...json },
				payload: { skillMd: `---\nname: pasted\ndescription: ${DESCRIPTION}\n---\n\nBody.\n` },
			});
			expect(pasted.statusCode).toBe(201);
			expect(pasted.json<SkillSummary>().source).toBe("managed");
			expect(existsSync(join(t.home, "skills", "pasted", "SKILL.md"))).toBe(true);

			const outside = join(t.home, "elsewhere", "pdf-tools");
			mkdirSync(outside, { recursive: true });
			writeFileSync(
				join(outside, "SKILL.md"),
				`---\nname: pdf-tools\ndescription: ${DESCRIPTION}\n---\n\nBody.\n`,
			);
			const registered = await t.app.inject({
				method: "POST",
				url: "/api/skills/import",
				headers: { ...me.headers, ...json },
				payload: { path: outside },
			});
			expect(registered.statusCode).toBe(201);
			expect(registered.json<SkillSummary>().source).toBe("external");
			expect(registered.json<SkillSummary>().path).toBe(outside);

			const again = await t.app.inject({
				method: "POST",
				url: "/api/skills/import",
				headers: { ...me.headers, ...json },
				payload: { path: outside },
			});
			expect(again.statusCode).toBe(409);
		});
	});

	it("[05-skills-and-tools#A.4] refuses a pasted SKILL.md that does not validate", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const res = await t.app.inject({
				method: "POST",
				url: "/api/skills/import",
				headers: { ...me.headers, ...json },
				payload: { skillMd: "# no frontmatter\n" },
			});
			expect(res.statusCode).toBe(400);
			expect(res.json<{ error: { code: string } }>().error.code).toBe("skill_invalid");
		});
	});
});

describe("skill test run", () => {
	it("[05-skills-and-tools#B.5.6] yields a transcript containing a read of that SKILL.md", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const created = await t.app.inject({
					method: "POST",
					url: "/api/skills",
					headers: { ...me.headers, ...json },
					payload: { name: "pdf-tools", description: DESCRIPTION },
				});
				const skill = created.json<SkillSummary>();
				const skillMd = join(skill.path, "SKILL.md");
				// The model's choice, scripted: pi's prompt tells it to read the skill file.
				t.services.fakeModel!.setScripts([
					[{ toolCall: { name: "read", args: { path: skillMd } } }],
					[{ text: "The skill says to do the thing." }],
				]);

				const res = await t.app.inject({
					method: "POST",
					url: `/api/skills/${skill.id}/test`,
					headers: { ...me.headers, ...json },
					payload: {},
				});
				expect(res.statusCode).toBe(201);
				const { conversationId, ephemeral } = res.json<SkillTestResponse>();
				expect(ephemeral).toBe(true);

				await waitUntil(
					() => t.services.hub.peek(conversationId)?.session.isStreaming === false,
					20_000,
				);
				const messages = (
					await t.app.inject({
						method: "GET",
						url: `/api/conversations/${conversationId}/messages`,
						headers: me.headers,
					})
				).json<{ messages: UiMessage[] }>().messages;
				const tool = messages
					.flatMap((message) => message.blocks)
					.find((block) => block.type === "tool");
				expect(tool).toBeDefined();
				expect(tool!.type === "tool" && tool!.name).toBe("read");
				expect(JSON.stringify(tool)).toContain(skillMd);

				// The auto prompt is the expanded skill command, so the skill body is in context.
				const firstUser = messages.find((message) => message.role === "user")!;
				const userText = firstUser.blocks
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("");
				expect(userText).toContain('<skill name="pdf-tools"');
				expect(firstUser.commandEcho?.typed).toBe("/skill:pdf-tools");

				// …and only `read` was granted (spec §A.4).
				const detail = await t.app.inject({
					method: "GET",
					url: `/api/conversations/${conversationId}`,
					headers: me.headers,
				});
				expect(detail.json<{ tools: { name: string }[] }>().tools.map((x) => x.name)).toEqual([
					"read",
				]);

				// It is a throwaway: never listed.
				const list = await t.app.inject({
					method: "GET",
					url: "/api/conversations",
					headers: me.headers,
				});
				expect(list.json<ConversationsResponse>().items.map((item) => item.id)).not.toContain(
					conversationId,
				);
			},
			{ env: { PIUI_FAKE_MODEL: "1" } },
		);
	});

	it("[05-skills-and-tools#A.4] sweeps a test-run conversation an hour later", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const skill = (
					await t.app.inject({
						method: "POST",
						url: "/api/skills",
						headers: { ...me.headers, ...json },
						payload: { name: "sweepable", description: DESCRIPTION },
					})
				).json<SkillSummary>();
				t.services.fakeModel!.setScripts([[{ text: "ok" }]]);
				const { conversationId } = (
					await t.app.inject({
						method: "POST",
						url: `/api/skills/${skill.id}/test`,
						headers: { ...me.headers, ...json },
						payload: {},
					})
				).json<SkillTestResponse>();
				expect(t.ctx.repos.conversations.getById(conversationId)).toBeDefined();

				t.clock.advance(EPHEMERAL_TTL_MS + 1000);
				t.services.skillTests.sweep();
				expect(t.ctx.repos.conversations.getById(conversationId)).toBeUndefined();
				expect(existsSync(join(t.home, "scratch", conversationId))).toBe(false);
			},
			{ env: { PIUI_FAKE_MODEL: "1" } },
		);
	});
});
