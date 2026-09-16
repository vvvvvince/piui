// A ~120-line zip reader for skill import. spec/05-skills-and-tools.md §A.4 option 1.
//
// No dependency: node's `zlib.inflateRawSync` is the only thing a zip needs beyond parsing the
// central directory. Every hostile shape (traversal, absolute paths, symlinks, bombs) is refused
// **before** any file is written — the reader returns buffers, it never touches the filesystem.
import { inflateRawSync } from "node:zlib";
import { ApiError } from "../http/errors.js";

export const MAX_ZIP_ENTRIES = 500;
export const MAX_ZIP_ENTRY_BYTES = 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Unix file type bits in the high 16 bits of `externalAttributes`. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export interface SkillZipEntry {
	/** POSIX path relative to the archive root; already proven safe. */
	path: string;
	content: Buffer;
}

const invalid = (message: string): never => {
	throw new ApiError("skill_invalid", message);
};

const refuseEscape = (message: string): never => {
	throw new ApiError("path_escape", message);
};

/** Parses, checks, then inflates. Directory entries are dropped. */
export function readSkillZip(archive: Buffer): SkillZipEntry[] {
	const eocd = findEocd(archive);
	const count = archive.readUInt16LE(eocd + 10);
	let offset = archive.readUInt32LE(eocd + 16);
	if (count > MAX_ZIP_ENTRIES) {
		invalid(`The archive holds ${count} entries; the limit is ${MAX_ZIP_ENTRIES}.`);
	}

	interface Header {
		path: string;
		compression: number;
		compressedSize: number;
		declaredSize: number;
		localOffset: number;
	}
	const headers: Header[] = [];
	let declaredTotal = 0;

	for (let i = 0; i < count; i += 1) {
		if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIG) {
			invalid("The archive's central directory is truncated or not a zip file.");
		}
		const nameLength = archive.readUInt16LE(offset + 28);
		const extraLength = archive.readUInt16LE(offset + 30);
		const commentLength = archive.readUInt16LE(offset + 32);
		const external = archive.readUInt32LE(offset + 38);
		const rawName = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		const header: Header = {
			path: rawName,
			compression: archive.readUInt16LE(offset + 10),
			compressedSize: archive.readUInt32LE(offset + 20),
			declaredSize: archive.readUInt32LE(offset + 24),
			localOffset: archive.readUInt32LE(offset + 42),
		};
		offset += 46 + nameLength + extraLength + commentLength;

		if (((external >>> 16) & S_IFMT) === S_IFLNK) {
			refuseEscape(`${rawName} is a symlink; symlinks are refused on import.`);
		}
		if (rawName.endsWith("/")) continue; // a directory entry carries no data
		assertSafePath(rawName);
		if (header.declaredSize > MAX_ZIP_ENTRY_BYTES) {
			invalid(`${rawName} is larger than 1 MB uncompressed; a skill file must stay under that.`);
		}
		declaredTotal += header.declaredSize;
		if (declaredTotal > MAX_ZIP_TOTAL_BYTES) {
			invalid("The archive expands to more than 50 MB; refusing to extract it.");
		}
		headers.push(header);
	}

	if (headers.length > MAX_ZIP_ENTRIES) {
		invalid(`The archive holds ${headers.length} files; the limit is ${MAX_ZIP_ENTRIES}.`);
	}

	const entries: SkillZipEntry[] = [];
	let actualTotal = 0;
	for (const header of headers) {
		const content = inflateEntry(archive, header);
		// A lying central directory is the classic bomb: check what we actually got, too.
		if (content.length > MAX_ZIP_ENTRY_BYTES) {
			invalid(`${header.path} inflates to more than 1 MB; refusing to extract it.`);
		}
		actualTotal += content.length;
		if (actualTotal > MAX_ZIP_TOTAL_BYTES) {
			invalid("The archive expands to more than 50 MB; refusing to extract it.");
		}
		entries.push({ path: header.path, content });
	}
	return entries;
}

function inflateEntry(
	archive: Buffer,
	header: { path: string; compression: number; compressedSize: number; localOffset: number },
): Buffer {
	const local = header.localOffset;
	if (local + 30 > archive.length || archive.readUInt32LE(local) !== LOCAL_SIG) {
		invalid(`${header.path} points outside the archive.`);
	}
	const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
	const end = start + header.compressedSize;
	if (end > archive.length) invalid(`${header.path} is truncated.`);
	const data = archive.subarray(start, end);
	if (header.compression === 0) return Buffer.from(data);
	if (header.compression !== 8) {
		invalid(`${header.path} uses an unsupported compression method (${header.compression}).`);
	}
	try {
		// maxOutputLength makes a deflate bomb fail here rather than in memory.
		return inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
	} catch {
		return invalid(`${header.path} is corrupt or inflates beyond 1 MB.`) as never;
	}
}

/** §A.4: no `..`, no absolute path, no drive letter, no NUL. */
function assertSafePath(path: string): void {
	if (path.includes("\0")) refuseEscape("An archive entry name contains a NUL byte.");
	if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path)) {
		refuseEscape(`${path} is an absolute path; archive entries must be relative.`);
	}
	const parts = path.split(/[\\/]/);
	if (parts.some((part) => part === "..")) {
		refuseEscape(`${path} escapes the skill directory with "..".`);
	}
}

function findEocd(archive: Buffer): number {
	const min = Math.max(0, archive.length - 66 * 1024);
	for (let i = archive.length - 22; i >= min; i -= 1) {
		if (archive.readUInt32LE(i) === EOCD_SIG) return i;
	}
	return invalid("That file is not a zip archive.") as never;
}
