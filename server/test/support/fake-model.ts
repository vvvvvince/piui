// Test-facing wrapper around the scripted provider: builds an isolated ModelRuntime whose
// auth.json lives inside the temp home, registers the fake provider, and hands back a handle.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppContext } from "../../src/context.js";
import {
	type FakeModelHandle,
	type FakeModelOptions,
	registerFakeProvider,
} from "../../src/pi/fake-model.js";
import { assertInTempRoot } from "./temp-root-guard.js";

export type { Script, ScriptItem } from "../../src/pi/fake-model.js";

export interface FakeRuntime {
	runtime: ModelRuntime;
	fake: FakeModelHandle;
	model: any;
}

export async function createFakeRuntime(
	ctx: AppContext,
	options: FakeModelOptions = {},
): Promise<FakeRuntime> {
	assertInTempRoot(ctx.config.piAuthPath, "pi auth path");
	const runtime = await ModelRuntime.create({
		authPath: ctx.config.piAuthPath,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const fake = registerFakeProvider(runtime, options);
	const model = runtime.getModel(fake.providerId, fake.modelId);
	if (!model) throw new Error("fake model did not register");
	return { runtime, fake, model };
}
