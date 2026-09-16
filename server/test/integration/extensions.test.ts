// spec/16-extensions.md — install, probe, enumeration, per-profile disable and the kill switch.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionDetail,
	ExtensionRescanResponse,
	ExtensionSummary,
	ExtensionsResponse,
	FetchExtensionResponse,
} from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { BROKEN_EXTENSION, GOOD_EXTENSION } from "../support/extensions.js";
import type { MintedPrincipal } from "../support/principal.js";

const json = { "content-type": "application/json" };

async function stepUp(t: TestApp, me: MintedPrincipal): Promise<void> {
	const res = await t.app.inject({
		method: "POST",
		url: "/api/auth/step-up",
		headers: { ...me.headers, ...json },
		payload: { password: "test" },
	});
	expect(res.statusCode).toBe(204);
}

async function install(
	t: TestApp,
	me: MintedPrincipal,
	body: Record<string, unknown>,
): Promise<ReturnType<TestApp["app"]["inject"]>> {
	return t.app.inject({
		method: "POST",
		url: "/api/extensions",
		headers: { ...me.headers, ...json },
		payload: body,
	});
}

const list = async (t: TestApp, me: MintedPrincipal): Promise<ExtensionSummary[]> => {
	const res = await t.app.inject({ method: "GET", url: "/api/extensions", headers: me.headers });
	expect(res.statusCode).toBe(200);
	return res.json<ExtensionsResponse>().items;
};

describe("extensions", () => {
	it("[16-extensions#10.1] installs a pasted extension, naming the tool and command it registers", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			await stepUp(t, me);
			const res = await install(t, me, { name: "deployer", source: GOOD_EXTENSION });
			expect(res.statusCode).toBe(201);
			const created = res.json<ExtensionSummary>();
			expect(created.tools).toEqual(["deploy"]);
			expect(created.commands).toEqual(["deploy"]);
			expect(created.source).toBe("managed");
			expect(created.loadError).toBeNull();
			expect(existsSync(join(t.home, "extensions", "deployer.ts"))).toBe(true);

			// …and the catalog carries it as kind "extension"
			const tools = await t.app.inject({ method: "GET", url: "/api/tools", headers: me.headers });
			expect(
				tools
					.json<{ items: { name: string; kind: string }[] }>()
					.items.find((item) => item.name === "deploy")?.kind,
			).toBe("extension");
		});
	});

	it("[16-extensions#10.2] rejects a syntax error with the load error and writes nothing", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			await stepUp(t, me);
			const res = await install(t, me, { name: "broken", source: BROKEN_EXTENSION });
			expect(res.statusCode).toBe(400);
			const body = res.json<{ error: { code: string; message: string } }>();
			expect(body.error.code).toBe("extension_load_failed");
			expect(body.error.message).toMatch(/ParseError|Unexpected/);
			const dir = join(t.home, "extensions");
			expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
			expect(await list(t, me)).toEqual([]);
		});
	});

	it("[16-extensions#10.3] auto-registers ~/.pi/agent/extensions/*.ts as external and enabled", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const userDir = join(t.home, "user-pi", "agent", "extensions");
			mkdirSync(userDir, { recursive: true });
			writeFileSync(join(userDir, "ambient.ts"), GOOD_EXTENSION);

			const items = await list(t, me);
			const ambient = items.find((item) => item.name === "ambient");
			expect(ambient).toMatchObject({ source: "external", enabled: true, editable: false });
			expect(ambient?.tools).toEqual(["deploy"]);
			expect(ambient?.path).toBe(join(userDir, "ambient.ts"));
		});
	});

	it("[16-extensions#10.8] uninstall reports what disappears and moves the file to trash", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			await stepUp(t, me);
			const created = (await install(t, me, { name: "deployer", source: GOOD_EXTENSION })).json<{
				id: string;
			}>();
			const profile = await t.app.inject({
				method: "POST",
				url: "/api/profiles",
				headers: { ...me.headers, ...json },
				payload: { name: "P", disabledExtensionIds: [created.id] },
			});
			expect(profile.statusCode).toBe(201);

			const res = await t.app.inject({
				method: "DELETE",
				url: `/api/extensions/${created.id}`,
				headers: me.headers,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				affectedProfiles: ["P"],
				removedTools: ["deploy"],
				removedCommands: ["deploy"],
			});
			expect(existsSync(join(t.home, "extensions", "deployer.ts"))).toBe(false);
			expect(readdirSync(join(t.home, "trash", "extensions"))).toContain("deployer.ts");
			expect(await list(t, me)).toEqual([]);
		});
	});

	it("[16-extensions#10.9] URL install fetches without installing, and the kill switch refuses every mutation", async () => {
		const fetchStub = (async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("https://example.com/ext.ts");
			return new Response(GOOD_EXTENSION, {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		}) as unknown as typeof fetch;

		await withTestApp(
			async (t) => {
				const me = t.mint();
				await stepUp(t, me);
				const res = await t.app.inject({
					method: "POST",
					url: "/api/extensions/fetch",
					headers: { ...me.headers, ...json },
					payload: { url: "https://example.com/ext.ts" },
				});
				expect(res.statusCode).toBe(200);
				const fetched = res.json<FetchExtensionResponse>();
				expect(fetched.source).toBe(GOOD_EXTENSION);
				expect(fetched.name).toBe("ext");
				expect(fetched.sha256).toMatch(/^[0-9a-f]{64}$/);
				// nothing installed by the fetch itself
				expect(await list(t, me)).toEqual([]);
			},
			{ fetch: fetchStub, env: { PIUI_ALLOW_PRIVATE_HTTP_TOOLS: "1" } },
		);

		await withTestApp(
			async (t) => {
				const me = t.mint();
				await stepUp(t, me);
				for (const call of [
					install(t, me, { name: "deployer", source: GOOD_EXTENSION }),
					t.app.inject({
						method: "POST",
						url: "/api/extensions/fetch",
						headers: { ...me.headers, ...json },
						payload: { url: "https://example.com/ext.ts" },
					}),
					t.app.inject({
						method: "DELETE",
						url: "/api/extensions/whatever",
						headers: me.headers,
					}),
					t.app.inject({
						method: "POST",
						url: "/api/extensions/rescan",
						headers: { ...me.headers, ...json },
						payload: {},
					}),
				]) {
					const res = await call;
					expect(res.statusCode).toBe(403);
					expect(res.json<{ error: { code: string } }>().error.code).toBe(
						"extension_install_disabled",
					);
				}
				// reading still works (spec §7.4.3)
				const items = await t.app.inject({
					method: "GET",
					url: "/api/extensions",
					headers: me.headers,
				});
				expect(items.statusCode).toBe(200);
				expect(items.json<ExtensionsResponse>().installEnabled).toBe(false);
			},
			{ fetch: fetchStub, env: { PIUI_DISABLE_EXTENSION_INSTALL: "1" } },
		);
	});

	it("refuses an install without a step-up, and for a non-admin", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const noStepUp = await install(t, me, { name: "deployer", source: GOOD_EXTENSION });
			expect(noStepUp.statusCode).toBe(403);
			expect(noStepUp.json<{ error: { code: string } }>().error.code).toBe("step_up_required");

			const user = t.mint({ id: "bob", username: "bob", role: "user" });
			const forbidden = await install(t, user, { name: "deployer", source: GOOD_EXTENSION });
			expect(forbidden.statusCode).toBe(403);
			expect(forbidden.json<{ error: { code: string } }>().error.code).toBe("forbidden");
		});
	});

	it("refuses a duplicate name, a bad name and an oversized source", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			await stepUp(t, me);
			expect((await install(t, me, { name: "deployer", source: GOOD_EXTENSION })).statusCode).toBe(
				201,
			);
			const dup = await install(t, me, { name: "deployer", source: GOOD_EXTENSION });
			expect(dup.json<{ error: { code: string } }>().error.code).toBe("extension_name_taken");

			const bad = await install(t, me, { name: "Not A Name", source: GOOD_EXTENSION });
			expect(bad.json<{ error: { code: string } }>().error.code).toBe("validation_error");

			const huge = await install(t, me, { name: "huge", source: "x".repeat(1024 * 1024 + 1) });
			expect(huge.json<{ error: { code: string } }>().error.code).toBe("extension_too_large");
		});
	});

	it("re-probes on rescan and reports a file that was fixed on disk", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			await stepUp(t, me);
			const userDir = join(t.home, "user-pi", "agent", "extensions");
			mkdirSync(userDir, { recursive: true });
			writeFileSync(join(userDir, "ambient.ts"), BROKEN_EXTENSION);
			const broken = (await list(t, me)).find((item) => item.name === "ambient");
			expect(broken?.loadError).toMatch(/ParseError|Unexpected/);
			expect(broken?.tools).toEqual([]);

			writeFileSync(join(userDir, "ambient.ts"), GOOD_EXTENSION);
			const res = await t.app.inject({
				method: "POST",
				url: "/api/extensions/rescan",
				headers: { ...me.headers, ...json },
				payload: {},
			});
			expect(res.statusCode).toBe(200);
			expect(res.json<ExtensionRescanResponse>().updated).toBe(1);
			const fixed = (await list(t, me)).find((item) => item.name === "ambient");
			expect(fixed?.loadError).toBeNull();
			expect(fixed?.tools).toEqual(["deploy"]);
		});
	});

	it("serves the managed source for editing and re-probes on save", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			await stepUp(t, me);
			const created = (await install(t, me, { name: "deployer", source: GOOD_EXTENSION })).json<{
				id: string;
			}>();
			const detail = await t.app.inject({
				method: "GET",
				url: `/api/extensions/${created.id}`,
				headers: me.headers,
			});
			expect(detail.json<ExtensionDetail>().source_text).toBe(GOOD_EXTENSION);

			const broken = await t.app.inject({
				method: "PATCH",
				url: `/api/extensions/${created.id}`,
				headers: { ...me.headers, ...json },
				payload: { source: BROKEN_EXTENSION },
			});
			expect(broken.statusCode).toBe(400);
			expect(broken.json<{ error: { code: string } }>().error.code).toBe("extension_load_failed");
			// the good file survived the refused save
			const after = await t.app.inject({
				method: "GET",
				url: `/api/extensions/${created.id}`,
				headers: me.headers,
			});
			expect(after.json<ExtensionDetail>().source_text).toBe(GOOD_EXTENSION);
		});
	});
});
