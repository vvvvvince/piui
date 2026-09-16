// The `/` command surface: built-ins, the profile's skills, prompt templates from the three
// sources, and the workspace-trust gate. spec/15-commands-and-input.md §§1-3, 5.
//
// Nothing is cached: composing the set is three `readdirSync` calls, which is cheaper than the
// invalidation rules a cache would need (a pi session outlives a profile edit and a
// ConversationChannel outlives the session). The one place the set *is* held is pi itself —
// the session's ResourceLoader — and `hub.drop()` is what refreshes that.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
	CommandDescriptor,
	ProjectResourcesResponse,
	PromptRescanResponse,
	PromptsResponse,
	PromptTemplateSummary,
} from "@piui/shared";
import type { AppContext } from "../context.js";
import type { ConversationRow } from "../db/repositories/conversations.js";
import { type ComposedPrompts, composePromptTemplates } from "../pi/prompts.js";
import type { ProfileService } from "../profiles/service.js";
import type { SkillCatalog } from "../skills/catalog.js";

/**
 * spec/15-commands-and-input.md §1.2. Only commands whose target exists in this build are
 * listed: an entry in the menu that 404s would be worse than its absence (`/compact`,
 * `/export`, `/tree`, `/fork` land with their endpoints).
 */
const BUILTINS: readonly Omit<CommandDescriptor, "display" | "source">[] = [
	{ name: "model", description: "Switch the model", kind: "client", availableWhileStreaming: true },
	{
		name: "thinking",
		description: "Set the thinking level",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "new",
		description: "Start a new conversation",
		kind: "client",
		availableWhileStreaming: false,
	},
	{
		name: "name",
		description: "Rename this conversation",
		argumentHint: "<name>",
		kind: "server",
		availableWhileStreaming: true,
	},
	{
		name: "session",
		description: "Show session usage and cost",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "resume",
		description: "Pick a previous conversation",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "copy",
		description: "Copy the last answer",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "settings",
		description: "Open settings",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "hotkeys",
		description: "Show keyboard shortcuts",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "login",
		description: "Manage provider credentials",
		kind: "client",
		availableWhileStreaming: true,
	},
	{
		name: "logout",
		description: "Manage provider credentials",
		kind: "client",
		availableWhileStreaming: true,
	},
];

export interface CommandServiceDeps {
	skills: SkillCatalog;
	profiles: ProfileService;
	/** spec/16-extensions.md §4 — the commands the conversation's extensions registered. */
	extensions: {
		resolveFor(options: { profileId?: string | null }): { commandNames: string[] };
	};
	/** Drops the live sessions holding the old template set, and tells the clients. */
	onRescan?(): void;
}

export class CommandService {
	/** Last seen `path -> content length` per global source, for the rescan delta. */
	private snapshot = new Map<string, number>();

	constructor(
		private readonly ctx: AppContext,
		private readonly deps: CommandServiceDeps,
	) {
		this.snapshot = snapshotOf(this.prompts());
	}

	// ------------------------------------------------------ prompt templates

	/** The composed set for a conversation. Project templates need a **trusted** workspace. */
	prompts(workspaceId?: string | null): ComposedPrompts {
		const workspace = workspaceId ? this.ctx.repos.workspaces.getById(workspaceId) : undefined;
		const projectDir =
			workspace && workspace.trusted === 1 ? join(workspace.path, ".pi", "prompts") : undefined;
		return composePromptTemplates({
			piuiDir: this.ctx.config.paths.prompts,
			userDir: join(this.ctx.config.userAgentDir, "prompts"),
			...(projectDir ? { projectDir } : {}),
		});
	}

	/** `GET /api/prompts` — the two global sources (a workspace has no meaning here). */
	list(): PromptsResponse {
		const composed = this.prompts();
		this.snapshot = snapshotOf(composed);
		return {
			items: composed.templates.map(
				(template): PromptTemplateSummary => ({
					name: template.name,
					description: template.description,
					...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
					location: template.location,
					path: template.filePath,
					...(template.shadows
						? { shadows: template.shadows.filter((s): s is "piui" | "user" => s !== "project") }
						: {}),
				}),
			),
			sources: composed.sources,
		};
	}

	/** `POST /api/prompts/rescan` — the delta against the last listing, and a cache flush. */
	rescan(): PromptRescanResponse {
		const before = this.snapshot;
		const composed = this.prompts();
		const after = snapshotOf(composed);
		let added = 0;
		let updated = 0;
		for (const [path, size] of after) {
			if (!before.has(path)) added += 1;
			else if (before.get(path) !== size) updated += 1;
		}
		const removed = [...before.keys()].filter((path) => !after.has(path)).length;
		this.snapshot = after;
		this.deps.onRescan?.();
		return { added, updated, removed };
	}

	// ------------------------------------------------------------- commands

	/** spec §1.1 — computed per conversation: skills follow the profile, templates the workspace. */
	commandsFor(row: ConversationRow): CommandDescriptor[] {
		const items: CommandDescriptor[] = BUILTINS.map((builtin) => ({
			...builtin,
			display: `/${builtin.name}`,
			source: "builtin" as const,
		}));

		// Chat mode has no profile, so the skill section is simply absent (spec §1.3).
		if (row.mode === "agent" && row.profile_id) {
			try {
				for (const skill of this.deps.profiles.resolve(row.profile_id).skills) {
					items.push({
						name: `skill:${skill.name}`,
						display: `/skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						kind: "expand",
						availableWhileStreaming: true,
					});
				}
			} catch {
				/* a deleted profile leaves the transcript readable (spec/03-profiles.md §7) */
			}
		}

		// spec/16-extensions.md §4 — pi dispatches these itself inside `prompt()` (spike S9 §4),
		// so the client only has to send the text, even while streaming.
		for (const name of this.deps.extensions.resolveFor({ profileId: row.profile_id })
			.commandNames) {
			items.push({
				name,
				display: `/${name}`,
				description: "Registered by an extension",
				source: "extension",
				kind: "expand",
				availableWhileStreaming: true,
			});
		}

		for (const template of this.prompts(row.workspace_id).templates) {
			items.push({
				name: template.name,
				display: `/${template.name}`,
				description: template.description,
				...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
				source: "prompt",
				location: template.location,
				kind: "expand",
				availableWhileStreaming: true,
			});
		}
		return items;
	}

	// ------------------------------------------------------ workspace trust

	/** `GET /api/workspaces/:id/project-resources` — what trusting this folder would load. */
	projectResources(workspaceId: string): ProjectResourcesResponse {
		const row = this.ctx.repos.workspaces.getById(workspaceId);
		if (!row) throw new Error(`no workspace ${workspaceId}`);
		const piDir = join(row.path, ".pi");
		const names = (dir: string, suffix?: string): string[] => {
			try {
				return readdirSync(dir, { withFileTypes: true })
					.filter((entry) => (suffix ? entry.name.endsWith(suffix) : entry.isDirectory()))
					.map((entry) => (suffix ? entry.name.slice(0, -suffix.length) : entry.name))
					.sort();
			} catch {
				return [];
			}
		};
		return {
			hasPiDir: existsSync(piDir) || existsSync(join(row.path, ".agents", "skills")),
			prompts: names(join(piDir, "prompts"), ".md"),
			skills: [...names(join(piDir, "skills")), ...names(join(row.path, ".agents", "skills"))],
			// Project extensions are never loaded, trusted or not (decision Q3); listed so the
			// dialog can say so instead of overpromising.
			extensions: names(join(piDir, "extensions"), ".ts"),
			settings: existsSync(join(piDir, "settings.json")),
			trusted: row.trusted === 1,
			trustDecidedAt: row.trust_decided_at,
		};
	}
}

function snapshotOf(composed: ComposedPrompts): Map<string, number> {
	return new Map(composed.templates.map((t) => [t.filePath, t.content.length]));
}
