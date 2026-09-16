// spec/08-agent-mode.md §6 — runaway guards, and *only* guards: piui has no approval gate,
// no denylist and no Approve/Deny state anywhere (decisions Q3/Q9).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ConversationDetail, CreateConversationResponse, UiEvent } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";
import { withWorkspace } from "../support/workspace.js";

const json = { "content-type": "application/json" };

async function agentIn(
	t: TestApp,
	me: MintedPrincipal,
	wsPath: string,
	toolNames: string[],
): Promise<ConversationDetail> {
	const fake = t.services.fakeModel!;
	const profile = await t.app.inject({
		method: "POST",
		url: "/api/profiles",
		headers: { ...me.headers, ...json },
		payload: { name: "Runner", toolNames },
	});
	const workspace = await t.app.inject({
		method: "POST",
		url: "/api/workspaces",
		headers: { ...me.headers, ...json },
		payload: { name: "ws", path: wsPath },
	});
	const res = await t.app.inject({
		method: "POST",
		url: "/api/conversations",
		headers: { ...me.headers, ...json },
		payload: {
			mode: "agent",
			provider: fake.providerId,
			modelId: fake.modelId,
			profileId: profile.json<{ id: string }>().id,
			workspaceId: workspace.json<{ id: string }>().id,
			title: "Runaway",
		},
	});
	expect(res.statusCode).toBe(201);
	return res.json<CreateConversationResponse>().conversation;
}

const noticesOf = (frames: { json<T>(): T }[]): string[] =>
	frames
		.map((f) => f.json<UiEvent>())
		.filter((e): e is Extract<UiEvent, { type: "notice" }> => e.type === "notice")
		.map((e) => e.text);

describe("runaway guards", () => {
	it("aborts a run that exceeds the wall-clock cap and says so in the transcript", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					t.services.fakeModel!.setScripts([[{ stall: 30_000 }, { text: "never" }]]);
					const conversation = await agentIn(t, me, ws.path, ["ls"]);
					const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
					await t.app.inject({
						method: "POST",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: { ...me.headers, ...json },
						payload: { text: "go forever" },
					});
					await stream.waitFor(
						(frames) => noticesOf(frames).some((text) => /cap|stopped/i.test(text)),
						20_000,
					);
					expect(noticesOf(stream.frames).join(" ")).toMatch(/PIUI_MAX_RUN_MINUTES|minute/i);
					await waitUntil(
						() => t.services.hub.peek(conversation.id)?.session.isStreaming === false,
						20_000,
					);
					stream.stop();
				},
				{ env: { PIUI_FAKE_MODEL: "1", PIUI_MAX_RUN_MINUTES: "0.02" } },
			);
		});
	});

	it("aborts a run that exceeds the tool-call cap", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					t.services.fakeModel!.setScripts(
						Array.from({ length: 20 }, () => [{ toolCall: { name: "ls", args: {} } }]),
					);
					const conversation = await agentIn(t, me, ws.path, ["ls"]);
					const stream = await t.openSse(`/api/conversations/${conversation.id}/events`, me);
					await t.app.inject({
						method: "POST",
						url: `/api/conversations/${conversation.id}/messages`,
						headers: { ...me.headers, ...json },
						payload: { text: "loop forever" },
					});
					await stream.waitFor(
						(frames) => noticesOf(frames).some((text) => /tool call/i.test(text)),
						20_000,
					);
					await waitUntil(
						() => t.services.hub.peek(conversation.id)?.session.isStreaming === false,
						20_000,
					);
					// the guard stopped it well before the script ran out
					expect(t.services.fakeModel!.turnsServed).toBeLessThan(10);
					stream.stop();
				},
				{ env: { PIUI_FAKE_MODEL: "1", PIUI_MAX_TOOL_CALLS: "3" } },
			);
		});
	});

	it("[16-extensions#10.10] contains no approval-gate machinery at all (spec/08-agent-mode.md §6, decision Q3)", () => {
		const files = execFileSync("git", ["ls-files", "server/src", "client/src", "shared/src"], {
			cwd: new URL("../../..", import.meta.url).pathname,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean);
		const offenders = files.filter((file) => {
			const source = readFileSync(new URL(`../../../${file}`, import.meta.url).pathname, "utf8");
			// `confirmDangerous` / `confirm_dangerous` are the deleted gating field (spec/16 §8).
			return /\bApprove\b|\bDeny\b|requireApproval|confirmBeforeTool|toolDenylist|confirmDangerous|confirm_dangerous/.test(
				source,
			);
		});
		expect(offenders).toEqual([]);
	});
});
