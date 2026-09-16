import { useQuery } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";
import { api } from "../api/client.js";
import { CommandPalette } from "./CommandPalette.js";
import { Sidebar } from "./Sidebar.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { UserMenu } from "./UserMenu.js";

export function AppShell(): JSX.Element {
	const health = useQuery({ queryKey: ["health"], queryFn: api.health });

	return (
		<div className="flex h-full">
			{/* spec/10-frontend.md §5 — keyboard users reach the content without tabbing the nav. */}
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-sky-700 focus:px-3 focus:py-1 focus:text-sm"
			>
				Skip to content
			</a>
			<Sidebar />
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex h-12 items-center justify-between border-b border-slate-800 px-4">
					<span className="text-sm text-slate-400">Web UI for the pi coding agent</span>
					<div className="flex items-center gap-3">
						<ThemeToggle />
						<span className="text-xs text-slate-500" data-testid="posture">
							{health.isPending
								? "checking…"
								: health.isError
									? "server unreachable"
									: `v${health.data.version} · pi ${health.data.piVersion}${
											health.data.container ? " · container" : ""
										}`}
						</span>
						<UserMenu />
					</div>
				</header>
				<main id="main" className="min-h-0 flex-1 overflow-auto p-6">
					<Outlet />
				</main>
				<CommandPalette />
			</div>
		</div>
	);
}
