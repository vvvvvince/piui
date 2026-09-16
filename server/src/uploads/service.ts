// Image uploads. spec/09-api.md §10, spec/07-chat-mode.md §6.4.
//
// The declared content type is never trusted: the magic bytes decide. The id is the sha256 of
// the bytes, which makes the transcript projection able to rebuild the URL without a mapping
// table (and deduplicates re-uploads of the same picture for free).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../context.js";
import { ApiError } from "../http/errors.js";

export interface StoredUpload {
	id: string;
	url: string;
	mimeType: string;
	size: number;
}

const SIGNATURES: { mimeType: string; ext: string; test(buffer: Buffer): boolean }[] = [
	{
		mimeType: "image/png",
		ext: "png",
		test: (b) =>
			b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	},
	{
		mimeType: "image/jpeg",
		ext: "jpg",
		test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	},
	{
		mimeType: "image/gif",
		ext: "gif",
		test: (b) => b.subarray(0, 6).toString("ascii").startsWith("GIF8"),
	},
	{
		mimeType: "image/webp",
		ext: "webp",
		test: (b) =>
			b.subarray(0, 4).toString("ascii") === "RIFF" &&
			b.subarray(8, 12).toString("ascii") === "WEBP",
	},
];

/** §10 — "validated by magic bytes, not just the declared type". */
export function sniffImage(buffer: Buffer): { mimeType: string; ext: string } | undefined {
	return SIGNATURES.find((signature) => signature.test(buffer));
}

export class UploadService {
	constructor(private readonly ctx: AppContext) {}

	get maxBytes(): number {
		return this.ctx.config.maxUploadMb * 1024 * 1024;
	}

	store(conversationId: string, buffer: Buffer): StoredUpload {
		if (buffer.length === 0) throw new ApiError("validation_error", "The uploaded file is empty.");
		if (buffer.length > this.maxBytes) {
			throw new ApiError(
				"validation_error",
				`That image is ${Math.round(buffer.length / 1024 / 1024)} MB; the limit is ${this.ctx.config.maxUploadMb} MB (PIUI_MAX_UPLOAD_MB).`,
			);
		}
		const sniffed = sniffImage(buffer);
		if (!sniffed) {
			throw new ApiError(
				"validation_error",
				"Only PNG, JPEG, GIF and WebP images can be uploaded (checked by content, not by name).",
			);
		}
		const id = `${createHash("sha256").update(buffer).digest("hex").slice(0, 32)}.${sniffed.ext}`;
		const dir = join(this.ctx.config.paths.uploads, conversationId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, id);
		if (!existsSync(path)) writeFileSync(path, buffer, { mode: 0o600 });
		return {
			id,
			url: `/api/uploads/${conversationId}/${id}`,
			mimeType: sniffed.mimeType,
			size: buffer.length,
		};
	}

	/** Reads a stored upload; the id is a bare filename, never a path. */
	read(conversationId: string, id: string): { buffer: Buffer; mimeType: string } {
		if (!/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(id)) {
			throw new ApiError("not_found", "No such upload.");
		}
		const path = join(this.ctx.config.paths.uploads, conversationId, id);
		if (!existsSync(path)) throw new ApiError("not_found", "No such upload.");
		const buffer = readFileSync(path);
		const sniffed = sniffImage(buffer);
		if (!sniffed) throw new ApiError("not_found", "No such upload.");
		return { buffer, mimeType: sniffed.mimeType };
	}

	/** Base64 for the model (pi's `ImageContent`), from an upload id. */
	imageOf(conversationId: string, id: string): { type: "image"; data: string; mimeType: string } {
		const { buffer, mimeType } = this.read(conversationId, id);
		return { type: "image", data: buffer.toString("base64"), mimeType };
	}

	/** Uploads of a conversation, for the "N attached" affordances. */
	list(conversationId: string): string[] {
		try {
			return readdirSync(join(this.ctx.config.paths.uploads, conversationId)).sort();
		} catch {
			return [];
		}
	}
}
