// The shared ModelRuntime: one per process, created at boot with `authPath: config.piAuthPath`
// (spec/01-architecture.md §4.2, spec/14-credentials.md §6).
import { readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { type FakeModelHandle, registerFakeProvider, type Script } from "./fake-model.js";

export type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PiRuntime {
	runtime: ModelRuntime;
	/** Only present under PIUI_FAKE_MODEL=1 (tests, demos) — never in a production boot. */
	fakeModel?: FakeModelHandle;
}

export async function createPiRuntime(config: Config): Promise<PiRuntime> {
	// refreshOnCreate populates the auth/availability snapshot so getProviderAuthStatus() is
	// accurate straight away; allowModelNetwork stays off so boot never touches the network
	// (spike plan/spikes/06 fact 2).
	const runtime = await ModelRuntime.create({
		authPath: config.piAuthPath,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	if (!config.fakeModel) return { runtime };
	const fakeModel = registerFakeProvider(runtime);
	// Dev-only seam: a JSON file of scripted turns, so a browser session can drive tool calls
	// (that is how the web_search card and the Sources footer are demoed offline).
	if (config.fakeScriptPath) {
		try {
			fakeModel.setScripts(JSON.parse(readFileSync(config.fakeScriptPath, "utf8")) as Script[]);
		} catch {
			/* a missing or broken script file leaves the default "ok" turn in place */
		}
	}
	return { runtime, fakeModel };
}
