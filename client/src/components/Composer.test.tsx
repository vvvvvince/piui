// spec/15-commands-and-input.md §4 — pi's editor semantics in a browser.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer, type ComposerHandlers } from "./Composer.js";

function setup(streaming: boolean, overrides: Partial<ComposerHandlers> = {}) {
	const handlers: ComposerHandlers = {
		onSend: vi.fn(),
		onSteer: vi.fn(),
		onFollowUp: vi.fn(),
		onAbort: vi.fn().mockResolvedValue(""),
		onDequeue: vi.fn().mockResolvedValue(""),
		...overrides,
	};
	render(<Composer streaming={streaming} handlers={handlers} conversationId="c1" />);
	return { handlers, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

describe("Composer", () => {
	it("[15-commands-and-input#4.1] Enter sends when idle and steers while streaming", async () => {
		const user = userEvent.setup();
		const idle = setup(false);
		await user.click(idle.textarea);
		await user.keyboard("hello{Enter}");
		expect(idle.handlers.onSend).toHaveBeenCalledWith("hello");
		expect(idle.textarea.value).toBe("");

		cleanup();
		const busy = setup(true);
		await user.click(busy.textarea);
		await user.keyboard("steer me{Enter}");
		expect(busy.handlers.onSteer).toHaveBeenCalledWith("steer me");
		expect(busy.handlers.onSend).not.toHaveBeenCalled();
	});

	it("[15-commands-and-input#4.1] Shift+Enter and Ctrl+J insert a newline instead of sending", async () => {
		const user = userEvent.setup();
		const { handlers, textarea } = setup(false);
		await user.click(textarea);
		await user.keyboard("one{Shift>}{Enter}{/Shift}two");
		fireEvent.keyDown(textarea, { key: "j", ctrlKey: true });
		expect(handlers.onSend).not.toHaveBeenCalled();
		expect(textarea.value).toContain("\n");
	});

	it("[15-commands-and-input#4.1] Alt+Enter queues a follow-up while streaming", async () => {
		const user = userEvent.setup();
		const { handlers, textarea } = setup(true);
		await user.click(textarea);
		await user.keyboard("later");
		fireEvent.keyDown(textarea, { key: "Enter", altKey: true });
		expect(handlers.onFollowUp).toHaveBeenCalledWith("later");
		expect(textarea.value).toBe("");
	});

	it("[15-commands-and-input#4.1] Esc aborts and restores the queue below what is typed", async () => {
		const user = userEvent.setup();
		const onAbort = vi.fn().mockResolvedValue("queued one\n\nqueued two");
		const { textarea } = setup(true, { onAbort });
		await user.click(textarea);
		await user.keyboard("draft");
		fireEvent.keyDown(textarea, { key: "Escape" });
		await vi.waitFor(() => expect(onAbort).toHaveBeenCalled());
		await vi.waitFor(() => expect(textarea.value).toBe("draft\n\nqueued one\n\nqueued two"));
	});

	it("[15-commands-and-input#4.1] Alt+Up dequeues without aborting", async () => {
		const onDequeue = vi.fn().mockResolvedValue("queued");
		const { textarea, handlers } = setup(true, { onDequeue });
		fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
		await vi.waitFor(() => expect(onDequeue).toHaveBeenCalled());
		expect(handlers.onAbort).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(textarea.value).toBe("queued"));
	});

	it("[15-commands-and-input#4.2] Up at the first line walks the prompt history", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem("piui.v1.history.c1", JSON.stringify(["first", "second"]));
		const { textarea } = setup(false);
		await user.click(textarea);
		fireEvent.keyDown(textarea, { key: "ArrowUp" });
		expect(textarea.value).toBe("second");
		fireEvent.keyDown(textarea, { key: "ArrowUp" });
		expect(textarea.value).toBe("first");
		fireEvent.keyDown(textarea, { key: "ArrowDown" });
		expect(textarea.value).toBe("second");
		window.localStorage.clear();
	});

	it("[15-commands-and-input#6.6] Enter steers, Alt+Enter queues, Alt+Up dequeues and Esc restores", async () => {
		const user = userEvent.setup();
		const restored = vi.fn().mockResolvedValue("steered\n\nqueued");
		const { handlers, textarea } = setup(true, {
			onDequeue: vi.fn().mockResolvedValue("steered\n\nqueued"),
			onAbort: restored,
		});
		await user.click(textarea);
		await user.keyboard("steered{Enter}");
		expect(handlers.onSteer).toHaveBeenCalledWith("steered");
		await user.keyboard("queued{Alt>}{Enter}{/Alt}");
		expect(handlers.onFollowUp).toHaveBeenCalledWith("queued");

		await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
		expect(textarea.value).toBe("steered\n\nqueued");

		await user.clear(textarea);
		await user.keyboard("{Escape}");
		expect(restored).toHaveBeenCalled();
		expect(textarea.value).toBe("steered\n\nqueued");
	});

	it("[15-commands-and-input#4.3] exposes every rebound key from the UI as well", () => {
		setup(true);
		// Stop button (Esc) and the queue hint are visible while streaming
		expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
		expect(screen.getByText(/Enter steers/i)).toBeInTheDocument();
	});
});

describe("Composer attachments", () => {
	it("[07-chat-mode#6.4] uploads a pasted image and sends it with the next prompt", async () => {
		const onSend = vi.fn();
		const onUpload = vi.fn(async () => ({
			uploadId: "abc.png",
			url: "/api/uploads/c1/abc.png",
			mimeType: "image/png",
		}));
		render(
			<Composer
				conversationId="c1"
				streaming={false}
				imagesSupported
				onUpload={onUpload}
				handlers={{
					onSend,
					onSteer: vi.fn(),
					onFollowUp: vi.fn(),
					onAbort: async () => "",
					onDequeue: async () => "",
				}}
			/>,
		);

		const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "p.png", {
			type: "image/png",
		});
		await userEvent.upload(screen.getByTestId("composer-file-input"), file);
		await waitFor(() => expect(onUpload).toHaveBeenCalled());
		expect(await screen.findByTestId("composer-attachments")).toBeInTheDocument();

		const area = screen.getByLabelText("Message");
		await userEvent.type(area, "what is this?");
		await userEvent.keyboard("{Enter}");

		expect(onSend).toHaveBeenCalledWith("what is this?", [
			{ uploadId: "abc.png", url: "/api/uploads/c1/abc.png", mimeType: "image/png" },
		]);
		// The tray is cleared after sending, so the next prompt does not re-attach it.
		expect(screen.queryByTestId("composer-attachments")).toBeNull();
	});

	it("[07-chat-mode#6.4] disables the attach button for a model without image input", () => {
		render(
			<Composer
				conversationId="c1"
				streaming={false}
				imagesSupported={false}
				handlers={{
					onSend: vi.fn(),
					onSteer: vi.fn(),
					onFollowUp: vi.fn(),
					onAbort: async () => "",
					onDequeue: async () => "",
				}}
			/>,
		);
		expect(screen.getByTestId("composer-attach")).toBeDisabled();
	});
});
