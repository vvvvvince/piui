// The seam that makes every later milestone testable. spec/20-development-method.md §9.2.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeSession } from "../support/agent.js";
import { createTempHome } from "../support/temp-home.js";
import { createWorkspace } from "../support/workspace.js";

describe("scripted fake model provider", () => {
	it("[20-development-method#9.2] streams a text answer in small deltas", async () => {
		const home = createTempHome();
		const ws = createWorkspace();
		try {
			const fake = await createFakeSession(home.ctx, { cwd: ws.path });
			fake.fake.setScripts([[{ text: "Hello from the fake model." }]]);
			await fake.session.prompt("hi");

			const deltas = fake.events
				.filter((e: any) => e.type === "message_update")
				.map((e: any) => e.assistantMessageEvent)
				.filter((e: any) => e.type === "text_delta")
				.map((e: any) => e.delta);
			expect(deltas.length).toBeGreaterThan(3);
			expect(deltas.join("")).toBe("Hello from the fake model.");
			expect(fake.assistantText()).toBe("Hello from the fake model.");
			fake.dispose();
		} finally {
			ws.cleanup();
			home.cleanup();
		}
	});

	it("[20-development-method#9.2] drives a multi-turn tool loop through the real write and bash tools", async () => {
		const home = createTempHome();
		const ws = createWorkspace();
		try {
			const fake = await createFakeSession(home.ctx, { cwd: ws.path, tools: ["write", "bash"] });
			fake.fake.setScripts([
				[
					{ thinking: "I will create the file first." },
					{
						toolCall: {
							name: "write",
							args: { path: join(ws.path, "made.txt"), content: "made by pi" },
						},
					},
				],
				[{ toolCall: { name: "bash", args: { command: `cat ${join(ws.path, "made.txt")}` } } }],
				[{ text: "The file says: made by pi" }],
			]);
			await fake.session.prompt("create and read a file");

			expect(readFileSync(join(ws.path, "made.txt"), "utf8")).toBe("made by pi");
			const toolRuns = fake.events.filter((e: any) => e.type === "tool_execution_end") as any[];
			expect(toolRuns.map((e) => e.toolName)).toEqual(["write", "bash"]);
			expect(JSON.stringify(toolRuns[1]!.result)).toContain("made by pi");
			expect(fake.assistantText()).toContain("The file says");
			expect(fake.fake.turnsServed).toBe(3);
			fake.dispose();
		} finally {
			ws.cleanup();
			home.cleanup();
		}
	});

	it("[20-development-method#9.2] surfaces a provider error and pi's auto-retry, then recovers", async () => {
		const home = createTempHome();
		const ws = createWorkspace();
		try {
			const fake = await createFakeSession(home.ctx, {
				cwd: ws.path,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			});
			fake.fake.setScripts([
				[{ error: { status: 503, message: "upstream unavailable" } }],
				[{ text: "recovered" }],
			]);
			await fake.session.prompt("go");

			const retries = fake.events.filter((e: any) => e.type === "auto_retry_start");
			expect(retries.length).toBeGreaterThanOrEqual(1);
			expect(fake.assistantText()).toContain("recovered");
			fake.dispose();
		} finally {
			ws.cleanup();
			home.cleanup();
		}
	});

	it("[20-development-method#9.2] lets abort interrupt a stalled turn", async () => {
		const home = createTempHome();
		const ws = createWorkspace();
		try {
			const fake = await createFakeSession(home.ctx, { cwd: ws.path });
			fake.fake.setScripts([[{ stall: 5_000 }, { text: "too late" }]]);

			const run = fake.session.prompt("go");
			await waitUntil(() => fake.session.isStreaming);
			await fake.session.abort();
			await run;

			expect(fake.assistantText()).not.toContain("too late");
			expect(fake.session.isStreaming).toBe(false);
			fake.dispose();
		} finally {
			ws.cleanup();
			home.cleanup();
		}
	});

	it("[20-development-method#9.2] reports deterministic usage and cost", async () => {
		const home = createTempHome();
		const ws = createWorkspace();
		try {
			const fake = await createFakeSession(home.ctx, { cwd: ws.path });
			fake.fake.setScripts([[{ text: "one" }]]);
			await fake.session.prompt("hi");
			const stats = fake.session.getSessionStats();
			expect(stats.tokens).toMatchObject({ input: 10, output: 20, total: 30 });
			expect(stats.cost).toBeCloseTo(0.003, 6);
			expect(stats.contextUsage?.contextWindow).toBe(100_000);
			fake.dispose();
		} finally {
			ws.cleanup();
			home.cleanup();
		}
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((r) => setImmediate(r));
	}
}
