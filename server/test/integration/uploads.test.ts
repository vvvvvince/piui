// spec/09-api.md §10 + spec/07-chat-mode.md §6.4 — uploads and image attachments.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { UiMessage, UploadResponse } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";

const json = { "content-type": "application/json" };

/** A real 1×1 PNG, built here so the fixture is readable rather than a base64 blob. */
function png(): Buffer {
	const chunk = (type: string, data: Buffer): Buffer => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "ascii");
		const crc = Buffer.alloc(4); // piui never verifies CRCs; decoders in the test do not run
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function multipart(file: Buffer, conversationId: string, filename = "pixel.png") {
	const boundary = "----piuiupload";
	const head = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n` +
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
			"Content-Type: image/png\r\n\r\n",
	);
	return {
		headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
		payload: Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
	};
}

async function newChat(t: TestApp, me: MintedPrincipal): Promise<string> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...me.headers, ...json },
		payload: {
			mode: "chat",
			provider: "piui-fake",
			modelId: "fake-1",
			title: "with an image",
		},
	});
	expect(res.statusCode).toBe(201);
	return res.json<{ conversation: { id: string } }>().conversation.id;
}

const fakeEnv = { env: { PIUI_FAKE_MODEL: "1" } };

describe("uploads", () => {
	it("[07-chat-mode#6.4] stores a PNG under the conversation and serves it inline, sandboxed", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const conversationId = await newChat(t, me);
			const { headers, payload } = multipart(png(), conversationId);

			const res = await t.app.inject({
				method: "POST",
				url: "/api/uploads",
				headers: { ...me.headers, ...headers },
				payload,
			});
			expect(res.statusCode).toBe(201);
			const upload = res.json<UploadResponse>();
			expect(upload.mimeType).toBe("image/png");
			expect(upload.url).toBe(`/api/uploads/${conversationId}/${upload.id}`);
			expect(existsSync(join(t.home, "uploads", conversationId, upload.id))).toBe(true);

			const served = await t.app.inject({ method: "GET", url: upload.url, headers: me.headers });
			expect(served.statusCode).toBe(200);
			expect(served.headers["content-type"]).toBe("image/png");
			expect(served.headers["content-disposition"]).toBe("inline");
			expect(served.headers["content-security-policy"]).toBe("sandbox");
			expect(served.headers["x-content-type-options"]).toBe("nosniff");
		}, fakeEnv);
	});

	it("[11-security#3] refuses a file whose magic bytes are not an image, whatever it claims", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const conversationId = await newChat(t, me);
			const { headers, payload } = multipart(
				Buffer.from("#!/bin/sh\nrm -rf /\n"),
				conversationId,
				"evil.png",
			);
			const res = await t.app.inject({
				method: "POST",
				url: "/api/uploads",
				headers: { ...me.headers, ...headers },
				payload,
			});
			expect(res.statusCode).toBe(400);
			expect(res.json<{ error: { message: string } }>().error.message).toMatch(/PNG, JPEG/);
			expect(t.services.uploads.list(conversationId)).toEqual([]);
		}, fakeEnv);
	});

	it("[09-api#10] enforces PIUI_MAX_UPLOAD_MB and refuses another user's conversation", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const conversationId = await newChat(t, me);
				const big = Buffer.concat([png(), Buffer.alloc(2 * 1024 * 1024)]);
				const { headers, payload } = multipart(big, conversationId);
				const res = await t.app.inject({
					method: "POST",
					url: "/api/uploads",
					headers: { ...me.headers, ...headers },
					payload,
				});
				expect(res.statusCode).toBe(400);
				expect(res.json<{ error: { message: string } }>().error.message).toContain(
					"PIUI_MAX_UPLOAD_MB",
				);

				const bob = t.mint({ id: "bob", role: "user" });
				const stolen = multipart(png(), conversationId);
				const forbidden = await t.app.inject({
					method: "POST",
					url: "/api/uploads",
					headers: { ...bob.headers, ...stolen.headers },
					payload: stolen.payload,
				});
				expect(forbidden.statusCode).toBe(404);
			},
			{ env: { PIUI_FAKE_MODEL: "1", PIUI_MAX_UPLOAD_MB: "1" } },
		);
	});

	it("[07-chat-mode#6.4] attaches an uploaded image to a prompt and shows it in the user bubble", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const conversationId = await newChat(t, me);
			t.services.fakeModel!.setScripts([[{ text: "I see one red pixel." }]]);
			const { headers, payload } = multipart(png(), conversationId);
			const upload = (
				await t.app.inject({
					method: "POST",
					url: "/api/uploads",
					headers: { ...me.headers, ...headers },
					payload,
				})
			).json<UploadResponse>();

			const sent = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${conversationId}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "what is this?", attachments: [{ uploadId: upload.id }] },
			});
			expect(sent.statusCode).toBe(202);
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
			const user = messages.find((message) => message.role === "user")!;
			expect(user.attachments).toEqual([
				{ id: upload.id, kind: "image", mimeType: "image/png", url: upload.url },
			]);
		}, fakeEnv);
	});

	it("[07-chat-mode#6.4] carries the attachment on the live SSE frame, not only after a reload", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const conversationId = await newChat(t, me);
			t.services.fakeModel!.setScripts([[{ text: "A red pixel." }]]);
			const { headers, payload } = multipart(png(), conversationId);
			const upload = (
				await t.app.inject({
					method: "POST",
					url: "/api/uploads",
					headers: { ...me.headers, ...headers },
					payload,
				})
			).json<UploadResponse>();

			const stream = await t.openSse(`/api/conversations/${conversationId}/events`, me);
			await t.app.inject({
				method: "POST",
				url: `/api/conversations/${conversationId}/messages`,
				headers: { ...me.headers, ...json },
				payload: { text: "what is this?", attachments: [{ uploadId: upload.id }] },
			});
			await stream.waitFor(
				(frames) =>
					frames.some((frame) => {
						const event = frame.json<{ type: string; message?: { role: string } }>();
						return event.type === "message_end" && event.message?.role === "user";
					}),
				20_000,
			);
			const userFrame = stream.frames
				.map((frame) =>
					frame.json<{
						type: string;
						message?: { role: string; attachments?: { url: string }[] };
					}>(),
				)
				.find((event) => event.type === "message_start" && event.message?.role === "user");
			expect(userFrame?.message?.attachments?.[0]?.url).toBe(upload.url);
			stream.stop();
		}, fakeEnv);
	});

	it("[09-api#10] accepts a small image inlined as base64 and stores it too", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const conversationId = await newChat(t, me);
			t.services.fakeModel!.setScripts([[{ text: "ok" }]]);
			const res = await t.app.inject({
				method: "POST",
				url: `/api/conversations/${conversationId}/messages`,
				headers: { ...me.headers, ...json },
				payload: {
					text: "inline one",
					attachments: [{ mimeType: "image/png", data: png().toString("base64") }],
				},
			});
			expect(res.statusCode).toBe(202);
			await waitUntil(
				() => t.services.hub.peek(conversationId)?.session.isStreaming === false,
				20_000,
			);
			expect(t.services.uploads.list(conversationId)).toHaveLength(1);
		}, fakeEnv);
	});

	it("[09-api#10] removes the upload directory when the conversation is deleted", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const conversationId = await newChat(t, me);
			const { headers, payload } = multipart(png(), conversationId);
			await t.app.inject({
				method: "POST",
				url: "/api/uploads",
				headers: { ...me.headers, ...headers },
				payload,
			});
			expect(existsSync(join(t.home, "uploads", conversationId))).toBe(true);
			const res = await t.app.inject({
				method: "DELETE",
				url: `/api/conversations/${conversationId}`,
				headers: me.headers,
			});
			expect(res.statusCode).toBe(204);
			expect(existsSync(join(t.home, "uploads", conversationId))).toBe(false);
		}, fakeEnv);
	});
});
