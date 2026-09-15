// spec/06-auth.md §6 — display name + "Sign out" in the top bar.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "./AuthGate.js";

export function UserMenu(): JSX.Element {
	const { user } = useAuth();
	const [open, setOpen] = useState(false);
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	async function signOut(): Promise<void> {
		try {
			await api.logout();
		} finally {
			queryClient.setQueryData(["me"], null);
			await queryClient.invalidateQueries({ queryKey: ["me"] });
			setOpen(false);
			navigate("/login", { replace: true });
		}
	}

	return (
		<div className="relative">
			<button
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="rounded px-2 py-1 text-sm text-slate-200 hover:bg-slate-800"
			>
				{user.displayName}
			</button>
			{open ? (
				<div
					role="menu"
					className="absolute right-0 z-20 mt-1 w-40 rounded border border-slate-700 bg-slate-900 py-1 shadow-lg"
				>
					<div className="px-3 py-1 text-xs text-slate-500">{user.roles.join(", ")}</div>
					<button
						type="button"
						role="menuitem"
						onClick={signOut}
						className="block w-full px-3 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-800"
					>
						Sign out
					</button>
				</div>
			) : null}
		</div>
	);
}
