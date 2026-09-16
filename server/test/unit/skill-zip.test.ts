// spec/05-skills-and-tools.md §A.4 import option 1 — the one genuinely hostile input in V1.
// Every refusal happens before a single byte is written, so each one gets its own test.
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ApiError } from "../../src/http/errors.js";
import { MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, readSkillZip } from "../../src/skills/zip.js";

interface ZipEntry {
	name: string;
	content: Buffer | string;
	/** Unix mode in the high 16 bits of the external attributes (0xA000 = symlink). */
	unixMode?: number;
	/** Lie about the uncompressed size in the central directory (zip-bomb shape). */
	declaredSize?: number;
	store?: boolean;
}

/** A minimal zip writer, so the suite can build hostile archives without a dependency. */
function buildZip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
		const store = entry.store ?? false;
		const data = store ? raw : deflateRawSync(raw);
		const crc = 0; // piui does not verify CRCs; the reader must not depend on it
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(store ? 0 : 8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(entry.declaredSize ?? raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		locals.push(local, data);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(store ? 0 : 8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(entry.declaredSize ?? raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
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

const SKILL = `---\nname: zipped\ndescription: A skill delivered as a zip archive for the import test.\n---\n\nBody.\n`;

const refusal = (zip: Buffer): ApiError => {
	try {
		readSkillZip(zip);
	} catch (error) {
		return error as ApiError;
	}
	throw new Error("expected the archive to be refused");
};

describe("skill zip import", () => {
	it("[05-skills-and-tools#A.4] reads a well-formed archive, deflated and stored", () => {
		const entries = readSkillZip(
			buildZip([
				{ name: "zipped/SKILL.md", content: SKILL },
				{ name: "zipped/references/api.md", content: "# API\n", store: true },
			]),
		);
		expect(entries.map((e) => e.path)).toEqual(["zipped/SKILL.md", "zipped/references/api.md"]);
		expect(entries[0]!.content.toString("utf8")).toBe(SKILL);
		expect(entries[1]!.content.toString("utf8")).toBe("# API\n");
	});

	it("[11-security#3] refuses an entry escaping with ..", () => {
		const error = refusal(
			buildZip([
				{ name: "zipped/SKILL.md", content: SKILL },
				{ name: "zipped/../../escape.md", content: "pwned" },
			]),
		);
		expect(error.code).toBe("path_escape");
		expect(error.message).toContain("escape.md");
	});

	it("[11-security#3] refuses an absolute entry", () => {
		expect(refusal(buildZip([{ name: "/etc/cron.d/pwn", content: "x" }])).code).toBe("path_escape");
		expect(refusal(buildZip([{ name: "C:\\windows\\pwn", content: "x" }])).code).toBe(
			"path_escape",
		);
	});

	it("[11-security#3] refuses a symlink entry", () => {
		const error = refusal(
			buildZip([
				{ name: "zipped/SKILL.md", content: SKILL },
				{ name: "zipped/link", content: "/etc/passwd", unixMode: 0o120777 },
			]),
		);
		expect(error.code).toBe("path_escape");
		expect(error.message).toMatch(/symlink/i);
	});

	it("[05-skills-and-tools#A.2] refuses a zip bomb by declared uncompressed size, before inflating", () => {
		// 60 × 1 MB of "small" entries: each is legal, the sum is not.
		const error = refusal(
			buildZip([
				{ name: "zipped/SKILL.md", content: SKILL },
				...Array.from({ length: 60 }, (_, i) => ({
					name: `zipped/bomb${i}.bin`,
					content: "small",
					declaredSize: MAX_ZIP_ENTRY_BYTES,
				})),
			]),
		);
		expect(error.code).toBe("skill_invalid");
		expect(error.message).toMatch(/50 MB/);
	});

	it("[05-skills-and-tools#A.2] refuses more than 500 entries and a single file over 1 MB", () => {
		const many = buildZip(
			Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
				name: `zipped/f${i}.md`,
				content: "x",
			})),
		);
		expect(refusal(many).message).toMatch(/500/);

		const fat = buildZip([
			{ name: "zipped/SKILL.md", content: SKILL },
			{ name: "zipped/fat.bin", content: "x", declaredSize: MAX_ZIP_ENTRY_BYTES + 1 },
		]);
		expect(refusal(fat).message).toMatch(/1 MB/);
	});

	it("[05-skills-and-tools#A.4] refuses a truncated or non-zip payload with a clear error", () => {
		expect(refusal(Buffer.from("not a zip at all")).code).toBe("skill_invalid");
		const good = buildZip([{ name: "zipped/SKILL.md", content: SKILL }]);
		expect(refusal(good.subarray(0, good.length - 10)).code).toBe("skill_invalid");
	});

	it("[05-skills-and-tools#A.2] refuses when the inflated bytes exceed the declared size", () => {
		// A liar: declares 5 bytes, actually inflates to 2 MB. The reader must cap while inflating.
		const error = refusal(
			buildZip([
				{ name: "zipped/SKILL.md", content: SKILL },
				{ name: "zipped/liar.bin", content: Buffer.alloc(2 * 1024 * 1024, 0x61), declaredSize: 5 },
			]),
		);
		expect(error.code).toBe("skill_invalid");
	});
});
