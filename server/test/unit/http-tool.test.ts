// spec/05-skills-and-tools.md §B.2 — the HTTP-tool schema builder, substitution and runtime.
import { describe, expect, it } from "vitest";
import type { ApiError } from "../../src/http/errors.js";
import { createHttpTool } from "../../src/pi/tools/http-tool.js";
import {
	buildParametersSchema,
	renderBody,
	renderUrl,
	validateHttpTool,
} from "../../src/tools/http-tools.js";

const base = {
	name: "weather",
	label: "Weather",
	description: "Look up the weather for a city. Use when the user asks about the weather.",
	method: "GET" as const,
	urlTemplate: "https://api.example.com/weather?city={city}",
	headers: { authorization: `Bearer \${WEATHER_KEY}` },
	bodyTemplate: null,
	parameters: [{ name: "city", type: "string" as const, required: true }],
	timeoutMs: 20_000,
};

const refuse = (input: Parameters<typeof validateHttpTool>[0]): ApiError => {
	try {
		validateHttpTool(input);
	} catch (error) {
		return error as ApiError;
	}
	throw new Error("expected a validation error");
};

describe("http tool definition", () => {
	it("[05-skills-and-tools#B.2] builds a TypeBox-compatible object schema from the builder rows", () => {
		const schema = buildParametersSchema([
			{ name: "city", type: "string", required: true, description: "City name." },
			{ name: "days", type: "number", required: false },
			{ name: "metric", type: "boolean", required: false },
			{ name: "tags", type: "string[]", required: false },
		]);
		expect(schema).toEqual({
			type: "object",
			additionalProperties: false,
			required: ["city"],
			properties: {
				city: { type: "string", description: "City name." },
				days: { type: "number" },
				metric: { type: "boolean" },
				tags: { type: "array", items: { type: "string" } },
			},
		});
	});

	it("[05-skills-and-tools#B.2] enforces the name rule and rejects an unknown placeholder", () => {
		expect(refuse({ ...base, name: "Weather" }).code).toBe("validation_error");
		expect(refuse({ ...base, name: "ab" }).code).toBe("validation_error");
		expect(refuse({ ...base, name: "a".repeat(49) }).code).toBe("validation_error");
		expect(validateHttpTool(base).name).toBe("weather");

		const unknown = refuse({
			...base,
			urlTemplate: "https://api.example.com/weather?city={city}&when={day}",
		});
		expect(unknown.message).toContain("{day}");

		expect(
			refuse({ ...base, method: "POST", bodyTemplate: '{"q":"{missing}"}' }).message,
		).toContain("{missing}");
		expect(refuse({ ...base, urlTemplate: "ftp://example.com" }).message).toMatch(/http/i);
		expect(refuse({ ...base, timeoutMs: 999 }).code).toBe("validation_error");
		expect(refuse({ ...base, method: "POST", bodyTemplate: "not json" }).message).toMatch(/JSON/i);
	});

	it("[05-skills-and-tools#B.2] substitutes {param} URL-encoded in the URL and JSON-encoded in the body", () => {
		expect(renderUrl("https://x.test/s?q={q}&n={n}", { q: "a b&c=d", n: 3 })).toBe(
			"https://x.test/s?q=a%20b%26c%3Dd&n=3",
		);
		expect(renderBody('{"q":{q},"deep":{"n":{n}}}', { q: 'he said "hi"', n: 2 })).toBe(
			'{"q":"he said \\"hi\\"","deep":{"n":2}}',
		);
	});
});

describe("http tool runtime", () => {
	const definition = {
		id: "t1",
		name: "weather",
		label: "Weather",
		description: base.description,
		method: "GET" as const,
		urlTemplate: "https://api.example.com/weather?city={city}",
		headers: { authorization: `Bearer \${WEATHER_KEY}`, "x-fixed": "plain" },
		bodyTemplate: null,
		parametersSchema: buildParametersSchema(base.parameters),
		timeoutMs: 20_000,
	};

	const run = async (
		overrides: Partial<Parameters<typeof createHttpTool>[0]> = {},
		params: Record<string, unknown> = { city: "Berlin" },
	) => {
		const calls: { url: string; init: RequestInit }[] = [];
		const tool = createHttpTool({
			definition,
			fetch: (async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return new Response(JSON.stringify({ temp: 12 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
			lookup: async () => ["93.184.216.34"],
			env: (name) => (name === "WEATHER_KEY" ? "s3cret" : undefined),
			...overrides,
		});
		const result = await tool.execute(
			"call-1",
			params as never,
			undefined,
			undefined as never,
			{} as never,
		);
		return { calls, result };
	};

	it("[05-skills-and-tools#B.2] expands env-var headers at call time and pretty-prints JSON", async () => {
		const { calls, result } = await run();
		expect(calls[0]!.url).toBe("https://api.example.com/weather?city=Berlin");
		expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
		expect((calls[0]!.init.headers as Record<string, string>)["x-fixed"]).toBe("plain");
		expect(result.content[0]!.text).toContain('"temp": 12');
		expect(result.details).toMatchObject({ status: 200 });
	});

	it("[05-skills-and-tools#B.5.3] refuses a private address through the shared SSRF guard", async () => {
		const tool = createHttpTool({
			definition: { ...definition, urlTemplate: "http://127.0.0.1:1234/{city}" },
			fetch: (async () => {
				throw new Error("the guard must refuse before any fetch");
			}) as unknown as typeof fetch,
			lookup: async () => ["127.0.0.1"],
			env: () => undefined,
		});
		await expect(
			tool.execute("c", { city: "x" } as never, undefined, undefined as never, {} as never),
		).rejects.toThrow(/private address/i);
	});

	it("[05-skills-and-tools#B.2] reports a non-2xx with the body snippet and truncates long output", async () => {
		// pi 0.85.1 has no `isError` on a tool result: a thrown error *is* the error result (M5).
		await expect(
			run({
				fetch: (async () =>
					new Response("no such city", {
						status: 404,
						headers: { "content-type": "text/plain" },
					})) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/404[\s\S]*no such city/);

		const long = await run({
			fetch: (async () =>
				new Response("x".repeat(40_000), {
					status: 200,
					headers: { "content-type": "text/plain" },
				})) as unknown as typeof fetch,
		});
		expect(long.result.content[0]!.text).toMatch(/truncated/i);
		expect(long.result.content[0]!.text.length).toBeLessThan(34_000);
	});

	it("[05-skills-and-tools#B.2] never leaks a header value into the tool output or details", async () => {
		const { result } = await run();
		expect(JSON.stringify(result)).not.toContain("s3cret");
		expect(JSON.stringify(result)).not.toContain("WEATHER_KEY");
	});
});
