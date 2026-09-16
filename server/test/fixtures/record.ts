// Records the pi event/transcript fixtures the projection unit tests run against.
// Human-reviewed, committed, and NEVER regenerated in CI (spec/20-development-method.md §6).
//   npm run fixtures:record
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeSession } from "../support/agent.js";
import { createTempHome } from "../support/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
	const home = createTempHome();
	const cwd = join(home.home, "scratch", "fixture");
	mkdirSync(cwd, { recursive: true });

	const fake = await createFakeSession(home.ctx, { cwd, tools: ["write"] });
	fake.fake.setScripts([
		[
			{ thinking: "The user wants a file. I will write it." },
			{ toolCall: { name: "write", args: { path: join(cwd, "hello.txt"), content: "hi" } } },
		],
		[{ text: "Wrote hello.txt for you." }],
	]);
	await fake.session.prompt("write hello.txt");

	writeFileSync(join(here, "agent-events.json"), `${JSON.stringify(fake.events, replacer, 2)}\n`);
	const sessionFile = fake.session.sessionFile;
	if (sessionFile) {
		writeFileSync(join(here, "session.jsonl"), readFileSync(sessionFile, "utf8"));
	}
	writeFileSync(
		join(here, "messages.json"),
		`${JSON.stringify(fake.session.messages, replacer, 2)}\n`,
	);
	fake.dispose();
	home.cleanup();
	console.log("fixtures written to", here);
}

/** Absolute temp paths and timestamps would make the fixture non-deterministic. */
function replacer(key: string, value: unknown): unknown {
	if (key === "timestamp") return 1700000000000;
	if (typeof value === "string" && value.includes("/piui-test-")) {
		return value.replace(/\/tmp\/piui-test-[^/"\s]+/g, "/tmp/piui-fixture");
	}
	return value;
}

await main();
