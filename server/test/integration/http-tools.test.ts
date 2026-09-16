// spec/05-skills-and-tools.md §B.2 / spec/09-api.md §7 — HTTP-tool CRUD, masking and the guard.
import type { HttpToolDetail, HttpToolTestResponse, ToolsResponse, UiMessage } from "@piui/shared";
import { describe, expect, it } from "vitest";
import { type TestApp, withTestApp } from "../support/app.js";
import { waitUntil } from "../support/async.js";
import type { MintedPrincipal } from "../support/principal.js";
import { withWorkspace } from "../support/workspace.js";

const json = { "content-type": "application/json" };
/** Every name in this file resolves to a public address; no test touches a resolver. */
const PUBLIC_DNS = async (): Promise<string[]> => ["93.184.216.34"];

const TOOL = {
	name: "weather",
	label: "Weather",
	description: "Look up the weather for a city. Use it when the user asks about the weather.",
	method: "GET" as const,
	urlTemplate: "https://api.example.test/weather?city={city}",
	headers: { authorization: `Bearer \${WEATHER_KEY}`, "x-plain": "literal-secret" },
	parameters: [{ name: "city", type: "string" as const, required: true }],
	timeoutMs: 5000,
};

const create = (t: TestApp, me: MintedPrincipal, body: Record<string, unknown> = TOOL) =>
	t.app.inject({
		method: "POST",
		url: "/api/tools/http",
		headers: { ...me.headers, ...json },
		payload: body,
	});

const okFetch = (seen: { url: string; init: RequestInit }[]) =>
	(async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		return new Response(JSON.stringify({ temp: 12 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;

describe("http tools", () => {
	it("[05-skills-and-tools#B.2] creates an HTTP tool and lists it in the catalog as dangerous", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const res = await create(t, me);
				expect(res.statusCode).toBe(201);
				expect(res.json<HttpToolDetail>().parametersSchema).toMatchObject({
					type: "object",
					required: ["city"],
				});

				const catalog = await t.app.inject({
					method: "GET",
					url: "/api/tools",
					headers: me.headers,
				});
				const item = catalog.json<ToolsResponse>().items.find((i) => i.name === "weather")!;
				expect(item.kind).toBe("http");
				expect(item.dangerous).toBe(true);
				expect(item.selectableInProfile).toBe(true);
			},
			{ lookup: PUBLIC_DNS },
		);
	});

	it("[05-skills-and-tools#B.2] never returns a stored header value through any route", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const created = await create(t, me);
				const id = created.json<HttpToolDetail>().id;
				expect(created.body).not.toContain("literal-secret");
				expect(created.body).not.toContain("WEATHER_KEY");

				for (const url of ["/api/tools/http", `/api/tools/http/${id}`, "/api/tools"]) {
					const res = await t.app.inject({ method: "GET", url, headers: me.headers });
					expect(res.body, url).not.toContain("literal-secret");
					expect(res.body, url).not.toContain("WEATHER_KEY");
				}
				const detail = await t.app.inject({
					method: "GET",
					url: `/api/tools/http/${id}`,
					headers: me.headers,
				});
				expect(detail.json<HttpToolDetail>().headers).toEqual({
					authorization: "***",
					"x-plain": "***",
				});

				// A PATCH that echoes the mask back keeps the stored value rather than storing "***".
				const patched = await t.app.inject({
					method: "PATCH",
					url: `/api/tools/http/${id}`,
					headers: { ...me.headers, ...json },
					payload: { headers: { authorization: "***", "x-plain": "***" }, label: "Weather v2" },
				});
				expect(patched.statusCode).toBe(200);
				const seen: { url: string; init: RequestInit }[] = [];
				t.ctx.fetch = okFetch(seen);
				await t.app.inject({
					method: "POST",
					url: `/api/tools/http/${id}/test`,
					headers: { ...me.headers, ...json },
					payload: { params: { city: "Berlin" } },
				});
				expect((seen[0]!.init.headers as Record<string, string>)["x-plain"]).toBe("literal-secret");
			},
			{ lookup: PUBLIC_DNS },
		);
	});

	it("[05-skills-and-tools#B.2] tests a tool and echoes only the response", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const id = (await create(t, me)).json<HttpToolDetail>().id;
				const seen: { url: string; init: RequestInit }[] = [];
				t.ctx.fetch = okFetch(seen);

				const res = await t.app.inject({
					method: "POST",
					url: `/api/tools/http/${id}/test`,
					headers: { ...me.headers, ...json },
					payload: { params: { city: "Berlin" } },
				});
				expect(res.statusCode).toBe(200);
				const body = res.json<HttpToolTestResponse>();
				expect(body.status).toBe(200);
				expect(body.body).toContain('"temp": 12');
				expect(res.body).not.toContain("authorization");
				expect(seen[0]!.url).toBe("https://api.example.test/weather?city=Berlin");
			},
			{ lookup: PUBLIC_DNS },
		);
	});

	it("[05-skills-and-tools#B.5.3] refuses a tool pointing at http://127.0.0.1:1234 unless the env override is set", async () => {
		await withTestApp(async (t) => {
			const me = t.mint();
			const id = (
				await create(t, me, { ...TOOL, urlTemplate: "http://127.0.0.1:1234/w?city={city}" })
			).json<HttpToolDetail>().id;
			t.ctx.fetch = (async () => {
				throw new Error("the SSRF guard must refuse before any socket is opened");
			}) as unknown as typeof fetch;

			const res = await t.app.inject({
				method: "POST",
				url: `/api/tools/http/${id}/test`,
				headers: { ...me.headers, ...json },
				payload: { params: { city: "Berlin" } },
			});
			expect(res.statusCode).toBe(400);
			expect(res.json<{ error: { message: string } }>().error.message).toMatch(/private address/i);
		});

		// …and the documented escape hatch lets it through.
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const id = (
					await create(t, me, { ...TOOL, urlTemplate: "http://127.0.0.1:1234/w?city={city}" })
				).json<HttpToolDetail>().id;
				const seen: { url: string; init: RequestInit }[] = [];
				t.ctx.fetch = okFetch(seen);
				const res = await t.app.inject({
					method: "POST",
					url: `/api/tools/http/${id}/test`,
					headers: { ...me.headers, ...json },
					payload: { params: { city: "Berlin" } },
				});
				expect(res.statusCode).toBe(200);
				expect(seen).toHaveLength(1);
			},
			{ env: { PIUI_ALLOW_PRIVATE_HTTP_TOOLS: "1" }, lookup: PUBLIC_DNS },
		);
	});

	it("[05-skills-and-tools#B.2] refuses a name already used anywhere in the catalog", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				expect((await create(t, me)).statusCode).toBe(201);
				const duplicate = await create(t, me);
				expect(duplicate.statusCode).toBe(409);
				expect(duplicate.json<{ error: { code: string } }>().error.code).toBe("tool_name_taken");

				for (const name of ["bash", "web_search"]) {
					const res = await create(t, me, { ...TOOL, name });
					expect(res.statusCode, name).toBe(409);
					expect(res.json<{ error: { code: string } }>().error.code, name).toBe("tool_name_taken");
				}
			},
			{ lookup: PUBLIC_DNS },
		);
	});

	it("[05-skills-and-tools#B.2] deletes a tool, naming the profiles that lose it", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const id = (await create(t, me)).json<HttpToolDetail>().id;
				await t.app.inject({
					method: "POST",
					url: "/api/profiles",
					headers: { ...me.headers, ...json },
					payload: { name: "Weather watcher", toolNames: ["weather"] },
				});
				const res = await t.app.inject({
					method: "DELETE",
					url: `/api/tools/http/${id}`,
					headers: me.headers,
				});
				expect(res.statusCode).toBe(200);
				expect(res.json<{ affectedProfiles: string[] }>().affectedProfiles).toEqual([
					"Weather watcher",
				]);
				const catalog = await t.app.inject({
					method: "GET",
					url: "/api/tools",
					headers: me.headers,
				});
				expect(catalog.json<ToolsResponse>().items.some((i) => i.name === "weather")).toBe(false);
			},
			{ lookup: PUBLIC_DNS },
		);
	});

	it("[18-multi-user#5] keeps the HTTP-tool surface admin-only", async () => {
		await withTestApp(
			async (t) => {
				const me = t.mint();
				const id = (await create(t, me)).json<HttpToolDetail>().id;
				const user = t.mint({ id: "bob", role: "user" });
				for (const [method, url] of [
					["GET", "/api/tools/http"],
					["POST", "/api/tools/http"],
					["GET", `/api/tools/http/${id}`],
					["PATCH", `/api/tools/http/${id}`],
					["DELETE", `/api/tools/http/${id}`],
					["POST", `/api/tools/http/${id}/test`],
				] as const) {
					const res = await t.app.inject({
						method,
						url,
						headers: { ...user.headers, ...json },
						payload: method === "GET" || method === "DELETE" ? undefined : {},
					});
					expect(res.statusCode, `${method} ${url}`).toBe(403);
				}
			},
			{ lookup: PUBLIC_DNS },
		);
	});

	it("[05-skills-and-tools#B.4] gives an agent conversation the tool, and the model can call it", async () => {
		await withWorkspace(async (ws) => {
			await withTestApp(
				async (t) => {
					const me = t.mint();
					await create(t, me);
					const profile = await t.app.inject({
						method: "POST",
						url: "/api/profiles",
						headers: { ...me.headers, ...json },
						payload: { name: "Weather agent", toolNames: ["weather"] },
					});
					const workspace = await t.app.inject({
						method: "POST",
						url: "/api/workspaces",
						headers: { ...me.headers, ...json },
						payload: { name: "ws", path: ws.path },
					});
					expect(workspace.statusCode).toBe(201);
					const seen: { url: string; init: RequestInit }[] = [];
					t.ctx.fetch = okFetch(seen);
					t.services.fakeModel!.setScripts([
						[{ toolCall: { name: "weather", args: { city: "Berlin" } } }],
						[{ text: "It is 12 degrees." }],
					]);

					const conversation = await t.app.inject({
						method: "POST",
						url: "/api/conversations",
						headers: { ...me.headers, ...json },
						payload: {
							mode: "agent",
							provider: "piui-fake",
							modelId: "fake-1",
							profileId: profile.json<{ id: string }>().id,
							workspaceId: workspace.json<{ id: string }>().id,
							title: "weather run",
						},
					});
					expect(conversation.statusCode).toBe(201);
					const created = conversation.json<{
						conversation: { id: string; tools: { name: string }[] };
					}>().conversation;
					const id = created.id;
					expect(created.tools.map((x) => x.name)).toContain("weather");

					await t.app.inject({
						method: "POST",
						url: `/api/conversations/${id}/messages`,
						headers: { ...me.headers, ...json },
						payload: { text: "weather in Berlin?" },
					});
					await waitUntil(
						() => t.services.hub.peek(id)?.session.isStreaming === false && seen.length > 0,
						20_000,
					);
					expect(seen[0]!.url).toBe("https://api.example.test/weather?city=Berlin");
					const messages = (
						await t.app.inject({
							method: "GET",
							url: `/api/conversations/${id}/messages`,
							headers: me.headers,
						})
					).json<{ messages: UiMessage[] }>().messages;
					const tool = messages
						.flatMap((message) => message.blocks)
						.find((block) => block.type === "tool");
					expect(tool && tool.type === "tool" && tool.name).toBe("weather");
				},
				{ env: { PIUI_FAKE_MODEL: "1" }, lookup: PUBLIC_DNS },
			);
		});
	});
});
