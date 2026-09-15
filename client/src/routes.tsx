import type { RouteObject } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { LoginPage } from "./pages/LoginPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";

export const routes: RouteObject[] = [
	{ path: "/login", element: <LoginPage /> },
	{
		path: "/",
		element: <AuthGate />,
		children: [
			{ index: true, element: <PlaceholderPage title="Conversations" milestone="M2" /> },
			{ path: "conversations", element: <PlaceholderPage title="Conversations" milestone="M2" /> },
			{ path: "profiles", element: <PlaceholderPage title="Profiles" milestone="M5" /> },
			{ path: "workspaces", element: <PlaceholderPage title="Workspaces" milestone="M4" /> },
			{ path: "skills", element: <PlaceholderPage title="Skills" milestone="M6" /> },
			{ path: "tools", element: <PlaceholderPage title="Tools" milestone="M6" /> },
			{ path: "settings", element: <PlaceholderPage title="Settings" milestone="M7" /> },
		],
	},
];
