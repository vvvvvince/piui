import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom implements no layout, so it ships no scrollIntoView; the transcript calls it on mount.
if (!("scrollIntoView" in Element.prototype)) {
	Element.prototype.scrollIntoView = () => undefined;
}

afterEach(() => {
	cleanup();
});
