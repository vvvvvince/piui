// spec/09-api.md §10 — image uploads and their inline, sandboxed serving.
import type { Services } from "../../services.js";
import type { PiuiFastify } from "../auth.js";
import { ApiError } from "../errors.js";

export async function registerUploadRoutes(app: PiuiFastify, services: Services): Promise<void> {
	app.post("/api/uploads", async (req, reply) => {
		const parts = (
			req as unknown as {
				parts(): AsyncIterableIterator<{
					type: string;
					fieldname: string;
					value?: string;
					toBuffer?(): Promise<Buffer>;
				}>;
			}
		).parts();
		let conversationId: string | undefined;
		let buffer: Buffer | undefined;
		for await (const part of parts) {
			if (part.type === "file" && part.fieldname === "file") buffer = await part.toBuffer!();
			else if (part.type === "field" && part.fieldname === "conversationId") {
				conversationId = String(part.value);
			}
		}
		if (!conversationId) {
			throw new ApiError("validation_error", "`conversationId` is a required form field.");
		}
		if (!buffer) throw new ApiError("validation_error", "Attach the image in the `file` field.");
		// Authorization: uploads live under a conversation the caller must own.
		services.conversations.rowFor(req.principal!, conversationId);
		const stored = services.uploads.store(conversationId, buffer);
		reply.status(201);
		return stored;
	});

	app.get<{ Params: { conversationId: string; id: string } }>(
		"/api/uploads/:conversationId/:id",
		async (req, reply) => {
			services.conversations.rowFor(req.principal!, req.params.conversationId);
			const file = services.uploads.read(req.params.conversationId, req.params.id);
			reply
				.header("content-type", file.mimeType)
				.header("content-disposition", "inline")
				// §10: a served upload is never allowed to become an origin-privileged document.
				.header("content-security-policy", "sandbox")
				.header("x-content-type-options", "nosniff")
				.header("cache-control", "private, max-age=3600");
			return reply.send(file.buffer);
		},
	);
}
