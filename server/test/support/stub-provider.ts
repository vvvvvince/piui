// Hand-written pi `Provider`s for credential tests: pi 0.85.1 ships no ambient-only provider
// and no multi-prompt provider, so the ones acceptance 14-credentials#9.{3,4,5} needs are
// stubbed here and registered with `ModelRuntime.registerNativeProvider` (spike plan/spikes/06).
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface StubPromptSpec {
	type: "secret" | "text" | "select";
	message: string;
	placeholder?: string;
	options?: { id: string; label: string; description?: string }[];
	/** Where the answer is stored: the credential key, or a credential `env` entry. */
	storeAs: "key" | string;
}

export interface StubProviderOptions {
	id: string;
	name?: string;
	models?: string[];
	prompts?: StubPromptSpec[];
	/** Ambient-only providers omit `login` entirely (spec/14-credentials.md §1.2). */
	ambientLabel?: string;
	/** Reject the stored key: `resolve()` returns undefined, so checkAuth reports nothing. */
	accept?: (key: string) => boolean;
	/** Thrown from `login()` after the prompts — used for the error-sanitizer test. */
	failWith?: (values: Record<string, string>) => Error | undefined;
	notify?: { type: "info" | "progress"; message: string }[];
}

export function registerStubProvider(runtime: ModelRuntime, options: StubProviderOptions): void {
	const id = options.id;
	const modelIds = options.models ?? [`${id}-model`];
	const models = modelIds.map((modelId) => ({
		id: modelId,
		name: modelId,
		provider: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/never-called",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	}));

	const login = options.ambientLabel
		? undefined
		: async (interaction: {
				prompt(p: unknown): Promise<string>;
				notify(e: unknown): void;
			}): Promise<unknown> => {
				for (const event of options.notify ?? []) interaction.notify(event);
				const answers: Record<string, string> = {};
				for (const spec of options.prompts ?? [
					{ type: "secret", message: `Enter ${id} API key`, storeAs: "key" } as StubPromptSpec,
				]) {
					const { storeAs, ...prompt } = spec;
					answers[storeAs] = await interaction.prompt(prompt);
				}
				const failure = options.failWith?.(answers);
				if (failure) throw failure;
				const env = Object.fromEntries(Object.entries(answers).filter(([name]) => name !== "key"));
				return {
					type: "api_key",
					key: answers.key ?? "",
					...(Object.keys(env).length > 0 ? { env } : {}),
				};
			};

	const provider = {
		id,
		name: options.name ?? id,
		auth: {
			apiKey: {
				name: options.ambientLabel ? `${id} ambient credentials` : `${options.name ?? id} API key`,
				...(login ? { login } : {}),
				async resolve({ credential }: { credential?: { key?: string } }) {
					if (options.ambientLabel) {
						return { auth: { apiKey: "ambient" }, source: options.ambientLabel };
					}
					if (!credential?.key) return undefined;
					if (options.accept && !options.accept(credential.key)) return undefined;
					return { auth: { apiKey: credential.key }, source: "stored credential" };
				},
			},
		},
		getModels: () => models,
		stream: () => {
			throw new Error(`stub provider ${id} cannot stream`);
		},
		streamSimple: () => {
			throw new Error(`stub provider ${id} cannot stream`);
		},
	};

	runtime.registerNativeProvider(provider as never);
}
