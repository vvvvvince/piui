// spec/06-auth.md §6 — one GET /api/auth/me at boot, a splash while it is pending, a redirect
// to /login (preserving ?next) on 401, and the global 401 / step-up interceptors.

import type { MeResponse } from "@piui/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api, setAuthHandlers } from "../api/client.js";
import { AppShell } from "./AppShell.js";
import { StepUpDialog } from "./StepUpDialog.js";

const AuthContext = createContext<MeResponse | null>(null);

/** The authenticated principal; `roles` hides admin-only UI (the server is authoritative). */
export function useAuth(): MeResponse {
	const value = useContext(AuthContext);
	if (!value) throw new Error("useAuth() used outside AuthGate");
	return value;
}

export function useIsAdmin(): boolean {
	return useAuth().user.roles.includes("admin");
}

export function AuthGate(): JSX.Element {
	const location = useLocation();
	const queryClient = useQueryClient();
	const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
	const [stepUp, setStepUp] = useState<((confirmed: boolean) => void) | null>(null);
	const pendingStepUp = useRef<((confirmed: boolean) => void) | null>(null);

	useEffect(() => {
		setAuthHandlers({
			onUnauthenticated: () => {
				queryClient.setQueryData(["me"], null);
			},
			onStepUpRequired: () =>
				new Promise<boolean>((resolve) => {
					pendingStepUp.current = resolve;
					setStepUp(() => resolve);
				}),
		});
		return () => setAuthHandlers({});
	}, [queryClient]);

	const value = me.data ?? null;
	const context = useMemo(() => value, [value]);

	if (me.isPending) {
		return (
			<div className="flex h-full items-center justify-center text-sm text-slate-400">
				Loading piui…
			</div>
		);
	}

	if (!context) {
		const next = `${location.pathname}${location.search}`;
		return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
	}

	const resolveStepUp = (confirmed: boolean): void => {
		pendingStepUp.current?.(confirmed);
		pendingStepUp.current = null;
		setStepUp(null);
	};

	return (
		<AuthContext.Provider value={context}>
			<AppShell />
			{stepUp ? <StepUpDialog onResolved={resolveStepUp} /> : null}
		</AuthContext.Provider>
	);
}
