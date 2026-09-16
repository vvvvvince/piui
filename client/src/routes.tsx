import type { RouteObject } from "react-router-dom";
import { Navigate } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { ConversationPage } from "./pages/ConversationPage.js";
import { ConversationsPage } from "./pages/ConversationsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { ProvidersPage } from "./pages/ProvidersPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";

export const routes: RouteObject[] = [
	{ path: "/login", element: <LoginPage /> },
	{
		path: "/",
		element: <AuthGate />,
		children: [
			{ index: true, element: <Navigate to="/conversations" replace /> },
			{ path: "conversations", element: <ConversationsPage /> },
			{ path: "c/:id", element: <ConversationPage /> },
			{ path: "profiles", element: <PlaceholderPage title="Profiles" milestone="M5" /> },
			{ path: "workspaces", element: <PlaceholderPage title="Workspaces" milestone="M4" /> },
			{ path: "skills", element: <PlaceholderPage title="Skills" milestone="M6" /> },
			{ path: "tools", element: <ToolsPage /> },
			{ path: "settings", element: <PlaceholderPage title="Settings" milestone="M7" /> },
			{ path: "settings/providers", element: <ProvidersPage /> },
		],
	},
];
