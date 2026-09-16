// spec/15-commands-and-input.md §§1.2, 2, 4.2 — the `/` menu, Tab completion, the routing
// table and the refusal of an unknown command.
import type { CommandDescriptor } from "@piui/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer, type ComposerHandlers } from "./Composer.js";

const commands: CommandDescriptor[] = [
	{
		name: "hotkeys",
		display: "/hotkeys",
		description: "Show keyboard shortcuts",
		source: "builtin",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "compact",
		display: "/compact",
		description: "Compact the conversation",
		source: "builtin",
		kind: "server",
		availableWhileStreaming: false,
	},
	{
		name: "component",
		display: "/component",
		description: "Scaffold a component",
		argumentHint: "<Name> <behaviour>",
		source: "prompt",
		location: "project",
		kind: "expand",
		availableWhileStreaming: true,
	},
	{
		name: "skill:pdf-tools",
		display: "/skill:pdf-tools",
		description: "Read PDFs",
		source: "skill",
		kind: "expand",
		availableWhileStreaming: true,
	},
];

function setup(overrides: Partial<ComposerHandlers> = {}, streaming = false) {
	const handlers: ComposerHandlers = {
		onSend: vi.fn(),
		onSteer: vi.fn(),
		onFollowUp: vi.fn(),
		onAbort: vi.fn().mockResolvedValue(""),
		onDequeue: vi.fn().mockResolvedValue(""),
		...overrides,
	};
	const onCommand = vi.fn();
	render(
		<Composer
			streaming={streaming}
			handlers={handlers}
			conversationId="c1"
			commands={commands}
			onCommand={onCommand}
		/>,
	);
	return { handlers, onCommand, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

describe("slash menu", () => {
	it("[15-commands-and-input#6.1] lists every source with its location badge and argument hint", async () => {
		const user = userEvent.setup();
		const { textarea } = setup();
		await user.click(textarea);
		await user.keyboard("/");

		const menu = screen.getByRole("listbox", { name: "Commands" });
		expect(menu.textContent).toContain("/hotkeys");
		expect(menu.textContent).toContain("/skill:pdf-tools");
		expect(menu.textContent).toContain("/component");
		expect(menu.textContent).toContain("<Name> <behaviour>");
		expect(menu.textContent).toContain("project");
		expect(menu.textContent).toContain("Show keyboard shortcuts");
	});

	it("[15-commands-and-input#6.1] filters as you type and Tab completes the highlighted name", async () => {
		const user = userEvent.setup();
		const { textarea, handlers } = setup();
		await user.click(textarea);
		await user.keyboard("/comp");
		const menu = screen.getByRole("listbox", { name: "Commands" });
		expect(menu.textContent).toContain("/compact");
		expect(menu.textContent).toContain("/component");
		expect(menu.textContent).not.toContain("/hotkeys");

		await user.keyboard("{Tab}");
		expect(textarea.value).toBe("/compact ");
		expect(handlers.onSend).not.toHaveBeenCalled();
		expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
	});

	it("[15-commands-and-input#6.1] Enter accepts the highlighted item instead of sending", async () => {
		const user = userEvent.setup();
		const { textarea, handlers } = setup();
		await user.click(textarea);
		await user.keyboard("/comp{ArrowDown}{Enter}");
		expect(textarea.value).toBe("/component ");
		expect(handlers.onSend).not.toHaveBeenCalled();
	});

	it("[15-commands-and-input#6.5] refuses an unknown command inline, keeps it in the composer and sends nothing", async () => {
		const user = userEvent.setup();
		const { textarea, handlers, onCommand } = setup();
		await user.click(textarea);
		await user.keyboard("/compcat{Escape}{Enter}");

		expect(handlers.onSend).not.toHaveBeenCalled();
		expect(onCommand).not.toHaveBeenCalled();
		expect(textarea.value).toBe("/compcat");
		expect(screen.getByRole("alert").textContent).toContain("Unknown command `/compcat`");
	});

	it("[15-commands-and-input#6.1] routes a client command locally and an expand command to the model", async () => {
		const user = userEvent.setup();
		const { textarea, handlers, onCommand } = setup();
		await user.click(textarea);
		await user.keyboard("/hotkeys{Escape}{Enter}");
		expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "hotkeys" }), "");
		expect(handlers.onSend).not.toHaveBeenCalled();
		expect(textarea.value).toBe("");

		await user.keyboard('/component Button "click handler"{Escape}{Enter}');
		expect(handlers.onSend).toHaveBeenCalledWith('/component Button "click handler"');
	});

	it("[15-commands-and-input#6.1] refuses a command that is not available while streaming", async () => {
		const user = userEvent.setup();
		const { textarea, onCommand } = setup({}, true);
		await user.click(textarea);
		await user.keyboard("/compact{Escape}{Enter}");
		expect(onCommand).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain("while the agent is running");
	});
});
