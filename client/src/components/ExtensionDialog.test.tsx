// spec/16-extensions.md §5 — the dialog bridge, client side.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { applyEvent, emptyStreamState } from "../hooks/useConversationStream.js";
import { ExtensionDialog } from "./ExtensionDialog.js";

describe("ExtensionDialog", () => {
	it("[16-extensions#10.6] answers a confirm without ever calling window.confirm", async () => {
		const onAnswer = vi.fn();
		const spy = vi.spyOn(window, "confirm");
		render(
			<ExtensionDialog
				request={{ requestId: "r1", method: "confirm", title: "Really?", message: "ship it?" }}
				onAnswer={onAnswer}
			/>,
		);
		expect(screen.getByText("ship it?")).toBeTruthy();
		await userEvent.click(screen.getByTestId("extension-dialog-ok"));
		expect(onAnswer).toHaveBeenCalledWith({ confirmed: true });
		expect(spy).not.toHaveBeenCalled();
	});

	it("[16-extensions#10.6] returns the typed value for input and the choice for select", async () => {
		const onAnswer = vi.fn();
		const { unmount } = render(
			<ExtensionDialog
				request={{ requestId: "r2", method: "input", title: "Branch?", placeholder: "main" }}
				onAnswer={onAnswer}
			/>,
		);
		await userEvent.type(screen.getByTestId("extension-dialog-text"), "release");
		await userEvent.click(screen.getByTestId("extension-dialog-ok"));
		expect(onAnswer).toHaveBeenCalledWith({ value: "release" });
		unmount();

		render(
			<ExtensionDialog
				request={{ requestId: "r3", method: "select", title: "Env?", options: ["dev", "prod"] }}
				onAnswer={onAnswer}
			/>,
		);
		await userEvent.click(screen.getByTestId("extension-dialog-option-prod"));
		expect(onAnswer).toHaveBeenLastCalledWith({ value: "prod" });
	});
});

describe("stream state for the UI bridge", () => {
	it("[16-extensions#10.6] re-renders a pending request from a snapshot and closes it when another tab answers", () => {
		let state = applyEvent(emptyStreamState(), {
			type: "ui_request",
			seq: 1,
			requestId: "r1",
			method: "confirm",
			title: "Really?",
		});
		expect(state.uiRequests).toHaveLength(1);

		// a reload: the snapshot carries the still-pending request
		state = applyEvent(emptyStreamState(), {
			type: "snapshot",
			seq: 5,
			messages: [],
			state: {
				isStreaming: true,
				isCompacting: false,
				isRetrying: false,
				queued: { steering: 0, followUp: 0 },
				contextPercent: null,
			},
			pendingUiRequests: [{ requestId: "r1", method: "confirm", title: "Really?" }],
		});
		expect(state.uiRequests.map((r) => r.requestId)).toEqual(["r1"]);

		state = applyEvent(state, { type: "ui_request_resolved", seq: 6, requestId: "r1" });
		expect(state.uiRequests).toEqual([]);
	});

	it("keys status badges and widgets, and clears them on null", () => {
		let state = applyEvent(emptyStreamState(), {
			type: "status",
			seq: 1,
			key: "deploy",
			text: "deploying",
		});
		state = applyEvent(state, {
			type: "widget",
			seq: 2,
			key: "deploy",
			lines: ["step 1"],
			placement: "aboveEditor",
		});
		expect(state.statuses).toEqual([{ key: "deploy", text: "deploying" }]);
		expect(state.widgets).toEqual([{ key: "deploy", lines: ["step 1"], placement: "aboveEditor" }]);

		state = applyEvent(state, { type: "status", seq: 3, key: "deploy", text: null });
		state = applyEvent(state, {
			type: "widget",
			seq: 4,
			key: "deploy",
			lines: null,
			placement: "aboveEditor",
		});
		expect(state.statuses).toEqual([]);
		expect(state.widgets).toEqual([]);
	});
});
