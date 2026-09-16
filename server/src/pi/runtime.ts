// The shared ModelRuntime: one per process, created at boot with `authPath: config.piAuthPath`
// (spec/01-architecture.md §4.2, spec/14-credentials.md §6).
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { type FakeModelHandle, registerFakeProvider } from "./fake-model.js";

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
	return { runtime, fakeModel: registerFakeProvider(runtime) };
}
