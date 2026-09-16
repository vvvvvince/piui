// spec/10-frontend.md §5 — dark by default, light toggle, `prefers-color-scheme` respected,
// persisted under the versioned `piui.v1.` localStorage prefix (spec §6).
import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "dark" | "light";
const KEY = "piui.v1.theme";

export function readTheme(): ThemeChoice {
	const stored = globalThis.localStorage?.getItem(KEY);
	return stored === "dark" || stored === "light" ? stored : "system";
}

/** Applies the choice to <html>; `system` follows the media query. */
export function applyTheme(choice: ThemeChoice): void {
	const prefersLight =
		choice === "light" ||
		(choice === "system" && globalThis.matchMedia?.("(prefers-color-scheme: light)").matches);
	const root = globalThis.document?.documentElement;
	if (!root) return;
	root.classList.toggle("light", Boolean(prefersLight));
	root.style.colorScheme = prefersLight ? "light" : "dark";
}

export function ThemeToggle(): JSX.Element {
	const [choice, setChoice] = useState<ThemeChoice>(readTheme);

	useEffect(() => {
		applyTheme(choice);
		globalThis.localStorage?.setItem(KEY, choice);
	}, [choice]);

	const next: Record<ThemeChoice, ThemeChoice> = { system: "dark", dark: "light", light: "system" };
	const label: Record<ThemeChoice, string> = {
		system: "Theme: system",
		dark: "Theme: dark",
		light: "Theme: light",
	};

	return (
		<button
			type="button"
			data-testid="theme-toggle"
			aria-label={label[choice]}
			title={`${label[choice]} — click to switch`}
			className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300"
			onClick={() => setChoice(next[choice])}
		>
			{choice === "light" ? "☀" : choice === "dark" ? "☾" : "◐"}
		</button>
	);
}
