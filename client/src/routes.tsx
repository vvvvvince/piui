import type { RouteObject } from "react-router-dom";
import { Navigate } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { ConversationPage } from "./pages/ConversationPage.js";
import { ConversationsPage } from "./pages/ConversationsPage.js";
import { ExtensionsPage } from "./pages/ExtensionsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { ProfilesPage } from "./pages/ProfilesPage.js";
import { ProvidersPage } from "./pages/ProvidersPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";
import { WorkspacesPage } from "./pages/WorkspacesPage.js";

export const routes: RouteObject[] = [
	{ path: "/login", element: <LoginPage /> },
	{
		path: "/",
		element: <AuthGate />,
		children: [
			{ index: true, element: <Navigate to="/conversations" replace /> },
			{ path: "conversations", element: <ConversationsPage /> },
			{ path: "c/:id", element: <ConversationPage /> },
			{ path: "profiles", element: <ProfilesPage /> },
			{ path: "workspaces", element: <WorkspacesPage /> },
			{ path: "skills", element: <PlaceholderPage title="Skills" milestone="M6" /> },
			{ path: "tools", element: <ToolsPage /> },
			{ path: "extensions", element: <ExtensionsPage /> },
			{ path: "settings", element: <SettingsPage /> },
			{ path: "settings/providers", element: <ProvidersPage /> },
		],
	},
];
