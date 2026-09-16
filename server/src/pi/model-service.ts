// ModelService — the catalog behind GET /api/models (spec/09-api.md §3, plan/03 §2).
import type { ModelInfo, ModelsResponse, ThinkingLevel } from "@piui/shared";
import { THINKING_LEVELS } from "@piui/shared";
import type { ModelRuntime } from "./runtime.js";

const CACHE_TTL_MS = 60_000;
const REFRESH_DEADLINE_MS = 15_000;

export interface ModelServiceDeps {
	runtime: ModelRuntime;
	nowMs(): number;
}

export class ModelService {
	private cache: { at: number; items: ModelInfo[] } | undefined;
	private revision = 1;

	constructor(private readonly deps: ModelServiceDeps) {}

	get credentialsRevision(): number {
		return this.revision;
	}

	/** Called by every credential mutation (spec/14-credentials.md §3). */
	invalidate(): void {
		this.cache = undefined;
		this.revision += 1;
	}

	async list(): Promise<ModelsResponse> {
		const now = this.deps.nowMs();
		if (this.cache && now - this.cache.at < CACHE_TTL_MS) {
			return { items: this.cache.items, credentialsRevision: this.revision };
		}
		const items = await this.compose();
		this.cache = { at: now, items };
		return { items, credentialsRevision: this.revision };
	}

	async refresh(): Promise<ModelsResponse> {
		let aborted = false;
		const errors: { provider: string; message: string }[] = [];
		try {
			const result = await this.deps.runtime.refresh({
				signal: AbortSignal.timeout(REFRESH_DEADLINE_MS),
			});
			aborted = result.aborted === true;
			for (const [provider, error] of result.errors ?? new Map()) {
				errors.push({
					provider,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} catch (error) {
			aborted = true;
			errors.push({
				provider: "*",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		this.cache = undefined;
		const response = await this.list();
		return { ...response, refresh: { aborted, errors } };
	}

	/** Resolve one model for session construction; `undefined` when it is not registered. */
	getModel(provider: string, modelId: string): unknown {
		return this.deps.runtime.getModel(provider, modelId);
	}

	async isAvailable(provider: string, modelId: string): Promise<boolean> {
		const available = await this.deps.runtime.getAvailable(provider);
		return available.some((model) => model.id === modelId);
	}

	private async compose(): Promise<ModelInfo[]> {
		let available = this.deps.runtime.getAvailableSnapshot();
		if (available.length === 0) {
			try {
				available = await this.deps.runtime.getAvailable();
			} catch {
				available = [];
			}
		}
		const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
		return this.deps.runtime.getModels().map((model) => toModelInfo(model, availableKeys));
	}
}

type PiModel = {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
};

function toModelInfo(raw: unknown, availableKeys: Set<string>): ModelInfo {
	const model = raw as PiModel;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		thinkingLevels: thinkingLevelsOf(model),
		input: [...model.input],
		contextWindow: model.contextWindow,
		...(model.cost ? { cost: { ...model.cost } } : {}),
		available: availableKeys.has(`${model.provider}/${model.id}`),
	};
}

function thinkingLevelsOf(model: PiModel): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	if (!map) return [...THINKING_LEVELS];
	const supported = THINKING_LEVELS.filter((level) => level === "off" || map[level] !== null);
	return supported.length > 0 ? supported : [...THINKING_LEVELS];
}
