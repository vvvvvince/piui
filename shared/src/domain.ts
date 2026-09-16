// Domain types shared by server and client. Source of truth: spec/02-data-model.md §3.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type SessionMode = "chat" | "agent";

/** spec/01-architecture.md §4.1 — the single input to session construction. */
export interface SessionConfig {
	mode: SessionMode;
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	profileId?: string;
	workspaceId?: string;
	webSearch: boolean;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels: ThinkingLevel[];
	input: ("text" | "image")[];
	contextWindow: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	available: boolean;
}

export interface Owned {
	ownerId: string;
	visibility: "private" | "shared";
	isOwn: boolean;
}

export interface Profile extends Owned {
	id: string;
	name: string;
	description: string;
	agentsMd: string;
	skillIds: string[];
	toolNames: string[];
	memory: { enabled: boolean; path: string | null; sizeBytes?: number };
	defaults?: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel };
	createdAt: string;
	updatedAt: string;
}

/** spec/04-workspaces.md §3 — probed on every read, never cached into staleness. */
export interface WorkspaceStatus {
	exists: boolean;
	writable: boolean;
	isGitRepo: boolean;
	entryCount?: number;
}

export interface Workspace {
	id: string;
	name: string;
	path: string;
	description: string;
	trusted: boolean;
	status: WorkspaceStatus;
	/** Conversations pointing at this workspace (spec/04-workspaces.md §4). */
	activeConversations: number;
	createdAt: string;
	updatedAt: string;
}

export interface SkillSummary {
	id: string;
	dirName: string;
	name: string;
	description: string;
	enabled: boolean;
	source: "managed" | "external";
	path: string;
	files?: string[];
	warnings: string[];
}

export type ToolKind = "builtin_pi" | "builtin_piui" | "http" | "extension";

export interface ToolDescriptor {
	name: string;
	label: string;
	description: string;
	kind: ToolKind;
	enabled: boolean;
	selectableInProfile: boolean;
	dangerous: boolean;
	configurable: boolean;
}

/** A catalog row: the descriptor plus how many profiles selected it (spec/09-api.md §7). */
export interface ToolCatalogItem extends ToolDescriptor {
	usedByProfiles: number;
}

export interface ConversationSummary {
	id: string;
	title: string;
	mode: SessionMode;
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	profile?: { id: string; name: string };
	workspace?: { id: string; name: string; path: string };
	webSearch: boolean;
	archived: boolean;
	isStreaming: boolean;
	lastMessageAt: string | null;
	tokensTotal: number;
	costTotal: number;
	createdAt: string;
}

/** spec/06-auth.md §1 */
export interface Principal {
	id: string;
	username: string;
	displayName: string;
	roles: string[];
}
