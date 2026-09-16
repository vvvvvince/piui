import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "../api/client.js";
import { useIsAdmin } from "./AuthGate.js";
import { UserMenu } from "./UserMenu.js";

const NAV = [
	{ to: "/conversations", label: "Conversations" },
	{ to: "/profiles", label: "Profiles" },
	{ to: "/workspaces", label: "Workspaces" },
	{ to: "/skills", label: "Skills" },
	{ to: "/tools", label: "Tools" },
	// admin-only surfaces live under Settings (spec/18-multi-user.md §5)
	{ to: "/settings/providers", label: "Providers", adminOnly: true },
	{ to: "/settings", label: "Settings", adminOnly: true },
];

export function AppShell(): JSX.Element {
	const health = useQuery({ queryKey: ["health"], queryFn: api.health });
	const isAdmin = useIsAdmin();
	const nav = NAV.filter((item) => !item.adminOnly || isAdmin);

	return (
		<div className="flex h-full">
			<nav aria-label="Main" className="w-56 shrink-0 border-r border-slate-800 bg-slate-900 p-3">
				<div className="mb-4 px-2 text-lg font-semibold tracking-tight">piui</div>
				<ul className="space-y-1">
					{nav.map((item) => (
						<li key={item.to}>
							<NavLink
								to={item.to}
								className={({ isActive }) =>
									`block rounded px-2 py-1.5 text-sm ${
										isActive ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60"
									}`
								}
							>
								{item.label}
							</NavLink>
						</li>
					))}
				</ul>
			</nav>
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex h-12 items-center justify-between border-b border-slate-800 px-4">
					<span className="text-sm text-slate-400">Web UI for the pi coding agent</span>
					<div className="flex items-center gap-3">
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
				<main className="min-h-0 flex-1 overflow-auto p-6">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
