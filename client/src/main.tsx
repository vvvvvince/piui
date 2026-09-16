import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { applyTheme, readTheme } from "./components/ThemeToggle.js";
import { routes } from "./routes.js";

// Before first paint, so a light-mode user never sees a dark flash (spec/10-frontend.md §5).
applyTheme(readTheme());

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const router = createBrowserRouter(routes);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
