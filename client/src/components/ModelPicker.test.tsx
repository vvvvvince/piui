// spec/10-frontend.md §2 — the model picker. `GET /api/models` ships ~1355 models, so the
// list is rendered lazily: everything is searchable, only a slice is in the DOM.
import type { ModelInfo } from "@piui/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MODEL_RENDER_LIMIT, ModelPicker } from "./ModelPicker.js";

const model = (provider: string, id: string, available = true): ModelInfo =>
	({
		provider,
		id,
		name: id,
		available,
		contextWindow: 128_000,
		input: ["text"],
		thinkingLevels: [],
	}) as unknown as ModelInfo;

const many = (count: number): ModelInfo[] =>
	Array.from({ length: count }, (_, i) => model(`p${i % 40}`, `model-${i}`, false));

describe("ModelPicker", () => {
	it("[10-frontend#2] renders a bounded slice of a huge catalog and says how many are hidden", () => {
		render(
			<MemoryRouter>
				<ModelPicker models={many(1355)} value={null} onChange={vi.fn()} />
			</MemoryRouter>,
		);
		const buttons = screen.getAllByRole("button");
		expect(buttons.length).toBeLessThanOrEqual(MODEL_RENDER_LIMIT);
		expect(screen.getByText(/more — refine your search/i)).toBeTruthy();
	});

	it("[10-frontend#2] always keeps available models in the rendered slice", async () => {
		const models = [...many(1355), model("anthropic", "claude-opus-4-5")];
		render(
			<MemoryRouter>
				<ModelPicker models={models} value={null} onChange={vi.fn()} />
			</MemoryRouter>,
		);
		expect(screen.getByRole("button", { name: /claude-opus-4-5/ })).toBeTruthy();
	});

	it("[10-frontend#2] searches the whole catalog, not just the rendered slice", async () => {
		const onChange = vi.fn();
		const models = [...many(1355), model("openai", "gpt-needle")];
		render(
			<MemoryRouter>
				<ModelPicker models={models} value={null} onChange={onChange} />
			</MemoryRouter>,
		);
		await userEvent.type(screen.getByLabelText(/search models/i), "needle");
		const hit = screen.getByRole("button", { name: /gpt-needle/ });
		await userEvent.click(hit);
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-needle" }));
	});
});
