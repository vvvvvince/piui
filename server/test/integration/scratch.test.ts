// spec/07-chat-mode.md §5 — scratch cwd hygiene.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateConversationResponse } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { withTestApp } from "../support/app.js";

const FAKE = { env: { PIUI_FAKE_MODEL: "1" } };

describe("scratch directories", () => {
	it("[07-chat-mode#5.1] creates the cwd 0700, deletes it with the conversation, sweeps orphans on boot", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const created = await t.app.inject({
				method: "POST",
				url: "/api/conversations",
				headers: { ...me.headers, "content-type": "application/json" },
				payload: {
					mode: "chat",
					provider: t.services.fakeModel!.providerId,
					modelId: t.services.fakeModel!.modelId,
					title: "scratch",
				},
			});
			const chat = created.json<CreateConversationResponse>().conversation;
			await t.services.hub.ensure(chat.id);
			const scratch = join(t.ctx.config.paths.scratch, chat.id);
			expect(existsSync(scratch)).toBe(true);

			// an orphan from a deleted conversation is swept when a server boots
			const orphan = join(t.ctx.config.paths.scratch, "gone-conversation");
			mkdirSync(orphan, { recursive: true });
			writeFileSync(join(orphan, "stale"), "x");
			const rebooted = await buildServer(t.ctx);
			await rebooted.ready();
			await rebooted.close();
			expect(existsSync(orphan)).toBe(false);
			expect(existsSync(scratch)).toBe(true);

			const deleted = await t.app.inject({
				method: "DELETE",
				url: `/api/conversations/${chat.id}`,
				headers: me.headers,
			});
			expect(deleted.statusCode).toBe(204);
			expect(existsSync(scratch)).toBe(false);
		}, FAKE);
	});
});
