// spec/07-chat-mode.md §3 — the globe toggle in the composer mirrors `webSearch`.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WebSearchToggle } from "./WebSearchToggle.js";

describe("WebSearchToggle", () => {
	it("[07-chat-mode#3] reflects the conversation's webSearch and toggles it", async () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<WebSearchToggle value={false} configured onChange={onChange} disabled={false} />,
		);
		const button = screen.getByRole("button", { name: /web search/i });
		expect(button.getAttribute("aria-pressed")).toBe("false");

		await userEvent.click(button);
		expect(onChange).toHaveBeenCalledWith(true);

		rerender(<WebSearchToggle value configured onChange={onChange} disabled={false} />);
		expect(screen.getByRole("button", { name: /web search/i }).getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("[07-chat-mode#3] is disabled and explains itself when no provider is configured", async () => {
		const onChange = vi.fn();
		render(
			<WebSearchToggle value={false} configured={false} onChange={onChange} disabled={false} />,
		);
		const button = screen.getByRole("button", { name: /web search/i }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.title).toMatch(/not configured|no search provider/i);
		await userEvent.click(button);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("[07-chat-mode#3] cannot be toggled while the conversation is streaming", async () => {
		const onChange = vi.fn();
		render(<WebSearchToggle value={false} configured onChange={onChange} disabled />);
		await userEvent.click(screen.getByRole("button", { name: /web search/i }));
		expect(onChange).not.toHaveBeenCalled();
	});
});
