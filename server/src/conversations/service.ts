// Conversation domain logic: creation, the pi session factory behind the hub, prompts,
// abort/queue, stats and the auto-title. spec/09-api.md §8, spec/07-chat-mode.md.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	ConversationDetail,
	ConversationStatsResponse,
	ConversationSummary,
	CreateConversationRequest,
	PatchConversationRequest,
	Principal,
	ThinkingLevel,
} from "@piui/shared";
import type { AppContext } from "../context.js";
import type { ConversationRow } from "../db/repositories/conversations.js";
import { ApiError } from "../http/errors.js";
import { createSession, openSessionManager } from "../pi/agent-runner.js";
import { buildChatSystemPrompt, resolveChatTools } from "../pi/resources.js";
import { fallbackTitle, generateTitle } from "../pi/title.js";
import { createMemoryTool } from "../pi/tools/memory.js";
import type { ResolvedProfile } from "../profiles/service.js";
import type { Services } from "../services.js";
import type { SessionHandle, SessionHub } from "../session/hub.js";
import { projectTranscript } from "../session/transcript.js";

const SYSTEM_PROMPT_PREVIEW_LIMIT = 4 * 1024;

export class ConversationService {
	constructor(
		private readonly ctx: AppContext,
		private readonly services: Services,
		private readonly hub: SessionHub,
	) {}

	// ------------------------------------------------------------- creation

	async create(
		principal: Principal,
		body: CreateConversationRequest,
	): Promise<{ conversation: ConversationDetail; warnings: string[] }> {
		if (body.mode === "chat" && (body.profileId || body.workspaceId)) {
			throw new ApiError(
				"validation_error",
				"Chat mode has no profile and no workspace (spec/07-chat-mode.md §1).",
			);
		}
		// spec/08-agent-mode.md §1: both are required, and both must resolve.
		if (body.mode === "agent" && (!body.profileId || !body.workspaceId)) {
			throw new ApiError(
				"validation_error",
				"An agent conversation needs a profile and a workspace.",
			);
		}
		const model = this.services.models.getModel(body.provider, body.modelId);
		if (!model) {
			throw new ApiError(
				"model_unavailable",
				`No model ${body.provider}/${body.modelId} is registered.`,
			);
		}
		const warnings: string[] = [];
		if (!(await this.services.models.isAvailable(body.provider, body.modelId))) {
			warnings.push(
				`${body.provider} has no working credentials — add a provider key in Settings.`,
			);
		}

		let thinkingLevel = body.thinkingLevel;
		if (body.mode === "agent") {
			const profile = this.ctx.repos.profiles.get(principal, body.profileId!);
			if (!profile) throw new ApiError("profile_not_found", `No profile ${body.profileId}.`);
			if (!this.ctx.repos.workspaces.get(principal, body.workspaceId!)) {
				throw new ApiError("not_found", `No workspace ${body.workspaceId}.`);
			}
			// The M4 seam: the folder must still be there before a session is built (§1).
			this.services.workspaces.requireUsable(body.workspaceId!);
			// conversation request > profile default > "off" (§1).
			thinkingLevel = body.thinkingLevel ?? (profile.default_thinking as ThinkingLevel) ?? "off";
			warnings.push(...this.services.profiles.resolve(profile.id).warnings);
		}

		const row = this.ctx.repos.conversations.create(principal, {
			mode: body.mode,
			provider: body.provider,
			modelId: body.modelId,
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(body.mode === "agent"
				? { profileId: body.profileId, workspaceId: body.workspaceId }
				: {}),
			webSearch: body.webSearch === true,
			...(body.title ? { title: body.title } : {}),
			timezone: body.timezone ?? null,
		});

		// Agent mode builds the session eagerly so `systemPromptPreview` is the *real* composed
		// prompt (spec/09-api.md §8) rather than a guess.
		if (body.mode === "agent") await this.hub.ensure(row.id);
		const conversation = this.detail(this.ctx.repos.conversations.getOrThrow(principal, row.id));
		if (body.initialMessage) {
			await this.prompt(principal, row.id, body.initialMessage);
		}
		return { conversation, warnings };
	}

	// -------------------------------------------------------------- reading

	list(
		principal: Principal,
		options: { archived?: boolean; limit?: number },
	): ConversationSummary[] {
		return this.ctx.repos.conversations.list(principal, options).map((row) => this.summary(row));
	}

	summary(row: ConversationRow): ConversationSummary {
		const live = this.hub.peek(row.id);
		const profile = row.profile_id ? this.ctx.repos.profiles.getById(row.profile_id) : undefined;
		const workspace = row.workspace_id
			? this.ctx.repos.workspaces.getById(row.workspace_id)
			: undefined;
		return {
			id: row.id,
			title: row.title,
			mode: row.mode as "chat" | "agent",
			...(profile ? { profile: { id: profile.id, name: profile.name } } : {}),
			...(workspace
				? { workspace: { id: workspace.id, name: workspace.name, path: workspace.path } }
				: {}),
			model: { provider: row.provider, modelId: row.model_id },
			thinkingLevel: row.thinking_level as ThinkingLevel,
			webSearch: row.web_search === 1,
			archived: row.archived === 1,
			isStreaming: live?.session.isStreaming ?? false,
			lastMessageAt: row.last_message_at,
			tokensTotal: row.tokens_total,
			costTotal: row.cost_total,
			createdAt: row.created_at,
		};
	}

	detail(row: ConversationRow): ConversationDetail {
		const live = this.hub.peek(row.id);
		return {
			...this.summary(row),
			// The resolved set is echoed back so the UI shows exactly what the model can do
			// (spec/05-skills-and-tools.md §B.4, last rule).
			tools: this.resolvedTools(row),
			systemPromptPreview: (live?.session.systemPrompt ?? this.systemPromptFor(row)).slice(
				0,
				SYSTEM_PROMPT_PREVIEW_LIMIT,
			),
			state: live?.state ?? {
				isStreaming: false,
				isCompacting: false,
				isRetrying: false,
				queued: { steering: 0, followUp: 0 },
				contextPercent: null,
			},
		};
	}

	async get(principal: Principal, id: string): Promise<ConversationDetail> {
		const row = this.ctx.repos.conversations.getOrThrow(principal, id);
		// An agent conversation's prompt can only be read off a real session; a broken workspace
		// must still render the page, so a failure here falls back to the offline preview (§8.7).
		if (row.mode === "agent" && !this.hub.peek(id)) {
			try {
				await this.hub.ensure(id);
			} catch {
				/* the workspace or the profile is gone: detail() degrades gracefully */
			}
		}
		return this.detail(this.ctx.repos.conversations.getOrThrow(principal, id));
	}

	/** Transcript + the current event sequence, so a client can attach without a race. */
	async messages(principal: Principal, id: string) {
		const row = this.ctx.repos.conversations.getOrThrow(principal, id);
		const live = this.hub.peek(id);
		if (live) return { messages: live.messages(), seq: live.seq };
		if (!row.session_path) return { messages: [], seq: 0 };
		const revived = await this.hub.ensure(id);
		return { messages: revived.messages(), seq: revived.seq };
	}

	async stats(principal: Principal, id: string): Promise<ConversationStatsResponse> {
		const row = this.ctx.repos.conversations.getOrThrow(principal, id);
		const live = this.hub.peek(id) ?? (row.session_path ? await this.hub.ensure(id) : undefined);
		const stats = live?.session.getSessionStats();
		if (!stats) {
			return {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: row.cost_total,
				contextUsage: null,
				messages: { user: 0, assistant: 0, toolCalls: 0 },
			};
		}
		return {
			tokens: stats.tokens,
			cost: stats.cost,
			contextUsage: stats.contextUsage
				? {
						tokens: stats.contextUsage.tokens,
						contextWindow: stats.contextUsage.contextWindow,
						percent: Math.round(stats.contextUsage.percent * 1000) / 10,
					}
				: null,
			messages: {
				user: stats.userMessages,
				assistant: stats.assistantMessages,
				toolCalls: stats.toolCalls,
			},
		};
	}

	// ------------------------------------------------------------- mutation

	patch(principal: Principal, id: string, body: PatchConversationRequest): ConversationDetail {
		const row = this.ctx.repos.conversations.getOrThrow(principal, id);
		const live = this.hub.peek(id);
		// spec/09-api.md §8 — the guard lives in the domain, not in the route, so a future entry
		// point inherits it (mirrors M4's `requireUsable` decision).
		const movesProfileOrWorkspace =
			(body.profileId !== undefined && body.profileId !== row.profile_id) ||
			(body.workspaceId !== undefined && body.workspaceId !== row.workspace_id);
		if (movesProfileOrWorkspace && (row.session_path || live)) {
			throw new ApiError(
				"immutable_after_start",
				"This conversation has already started; its profile and workspace are fixed.",
			);
		}
		if (movesProfileOrWorkspace) {
			if (body.profileId !== undefined && !this.ctx.repos.profiles.get(principal, body.profileId)) {
				throw new ApiError("profile_not_found", `No profile ${body.profileId}.`);
			}
			if (body.workspaceId !== undefined) this.services.workspaces.requireUsable(body.workspaceId);
			this.ctx.repos.conversations.setProfileAndWorkspace(principal, id, {
				...(body.profileId === undefined ? {} : { profileId: body.profileId }),
				...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
			});
		}
		const touchesModel =
			body.provider !== undefined ||
			body.modelId !== undefined ||
			body.thinkingLevel !== undefined ||
			body.webSearch !== undefined;
		if (touchesModel && live?.session.isStreaming) {
			throw new ApiError("conversation_busy", "Wait for the answer to finish, or press Stop.");
		}
		if (body.title !== undefined) {
			this.ctx.repos.conversations.setTitle(principal, id, body.title);
		}
		if (body.archived !== undefined) {
			this.ctx.repos.conversations.setArchived(principal, id, body.archived);
		}
		if (touchesModel) {
			const provider = body.provider ?? row.provider;
			const modelId = body.modelId ?? row.model_id;
			if (!this.services.models.getModel(provider, modelId)) {
				throw new ApiError("model_unavailable", `No model ${provider}/${modelId} is registered.`);
			}
			this.ctx.repos.conversations.setModel(principal, id, {
				provider,
				modelId,
				...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
				...(body.webSearch === undefined ? {} : { webSearch: body.webSearch }),
			});
			// Applies from the next prompt; history is never rewritten (spec/07 §3).
			// The notice goes into the conversation channel, which outlives the session swap.
			this.hub.drop(id);
			this.hub.notify(id, {
				type: "notice",
				level: "info",
				text:
					body.provider || body.modelId
						? `Switched to ${modelId}`
						: body.webSearch === true
							? "Web search enabled"
							: body.webSearch === false
								? "Web search disabled"
								: "Conversation settings updated",
			});
		}
		return this.detail(this.ctx.repos.conversations.getOrThrow(principal, id));
	}

	delete(principal: Principal, id: string): void {
		const row = this.ctx.repos.conversations.getOrThrow(principal, id);
		this.hub.forget(id);
		this.ctx.repos.conversations.delete(principal, id);
		if (row.session_path) {
			try {
				rmSync(row.session_path, { force: true });
			} catch {
				/* the session file may already be gone */
			}
		}
		rmSync(this.scratchDir(id), { recursive: true, force: true });
		rmSync(join(this.ctx.config.paths.uploads, id), { recursive: true, force: true });
	}

	async prompt(
		principal: Principal,
		id: string,
		text: string,
		streamingBehavior?: "steer" | "followUp",
	): Promise<"steer" | "followUp" | null> {
		const row = this.ctx.repos.conversations.getOrThrow(principal, id);
		// spec/04-workspaces.md §§3,6 — a workspace whose folder vanished blocks new prompts with a
		// clear 409, never a 500 from a failed cwd. Agent mode (M5) reuses the same guard.
		if (row.workspace_id) this.services.workspaces.requireUsable(row.workspace_id);
		// spec/03-profiles.md §7: a deleted profile leaves the transcript readable but refuses new
		// prompts, with a message that says what happened.
		if (row.mode === "agent" && !row.profile_id) {
			throw new ApiError(
				"profile_not_found",
				"This conversation's profile was deleted, so it can no longer run. Start a new conversation.",
			);
		}
		const queuedAs = await this.hub.prompt(id, text, streamingBehavior);
		if (row.title_locked === 0 && row.title === "") {
			void this.autoTitle(row, text);
		}
		return queuedAs;
	}

	async abort(principal: Principal, id: string) {
		this.ctx.repos.conversations.getOrThrow(principal, id);
		return this.hub.abort(id);
	}

	async clearQueue(principal: Principal, id: string) {
		this.ctx.repos.conversations.getOrThrow(principal, id);
		const live = this.hub.peek(id);
		return live ? live.session.clearQueue() : { steering: [], followUp: [] };
	}

	// ------------------------------------------------------ session factory

	/** Handed to the SessionHub; runs without a request principal. */
	async createPiSession(conversationId: string): Promise<SessionHandle> {
		const row = this.ctx.repos.conversations.getById(conversationId);
		if (!row) throw new ApiError("not_found", "Conversation not found.");
		const model = this.services.models.getModel(row.provider, row.model_id);
		if (!model) {
			throw new ApiError(
				"model_unavailable",
				`No model ${row.provider}/${row.model_id} is registered.`,
			);
		}
		const agent = row.mode === "agent" ? this.resolveAgent(row) : undefined;
		// spec/08-agent-mode.md §1: cwd is the workspace, and the folder must still exist.
		const cwd = agent
			? this.services.workspaces.requireUsable(row.workspace_id!).path
			: this.scratchDir(conversationId);
		if (!agent) mkdirSync(cwd, { recursive: true, mode: 0o700 });

		const sessionManager = openSessionManager({
			cwd,
			sessionsDir: this.ctx.config.sessionsDir,
			path: row.session_path,
		});
		const toolNames = agent ? agent.toolNames : this.resolvedToolNames(row);
		// `noTools: "all"` would strip custom tools too, so the names *and* the definitions have
		// to travel together (spike plan/spikes/08).
		const wantsWeb = toolNames.includes("web_search") || toolNames.includes("web_fetch");
		const web = wantsWeb ? this.services.createWebToolSet() : undefined;
		const customTools = [
			...(web ? web.tools : []),
			...(agent && toolNames.includes("memory_append")
				? [this.memoryToolFor(conversationId, agent)]
				: []),
		];
		const handle = await createSession({
			config: {
				conversationId,
				mode: agent ? "agent" : "chat",
				model,
				thinkingLevel: row.thinking_level as ThinkingLevel,
				cwd,
				agentDir: this.ctx.config.agentDir,
				modelRuntime: this.services.modelRuntime,
				// Agent mode keeps pi's own prompt (spec/03-profiles.md §2, spike plan/spikes/09).
				...(agent ? {} : { systemPrompt: this.systemPromptFor(row) }),
				tools: toolNames,
				...(customTools.length > 0 ? { customTools } : {}),
				...(agent ? { agentsFiles: agent.agentsFiles, skills: agent.skills } : {}),
			},
			sessionManager,
		});
		if (web) {
			// the per-run search budget (§B.3: 10 searches per run) resets when a run starts
			(
				handle.session as unknown as {
					subscribe(listener: (event: { type: string }) => void): () => void;
				}
			).subscribe((event) => {
				if (event.type === "agent_start") web.beginRun();
			});
		}
		const sessionFile = handle.session.sessionFile;
		if (sessionFile && sessionFile !== row.session_path) {
			this.ctx.repos.conversations.setSessionPathById(conversationId, sessionFile);
		}
		return handle as SessionHandle;
	}

	/** Persist usage when a run settles (wired into the hub). */
	recordRunEnd(conversationId: string, session: { getSessionStats(): unknown }): void {
		try {
			const stats = session.getSessionStats() as {
				tokens: { total: number };
				cost: number;
			};
			this.ctx.repos.conversations.recordUsageById(conversationId, {
				tokensTotal: stats.tokens.total,
				costTotal: stats.cost,
			});
		} catch {
			/* stats are best effort */
		}
	}

	/** Boot sweep: scratch dirs of conversations that no longer exist (spec/07 §5). */
	sweepScratch(): void {
		const root = this.ctx.config.paths.scratch;
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (this.ctx.repos.conversations.getById(entry.name)) continue;
				rmSync(join(root, entry.name), { recursive: true, force: true });
			}
		} catch {
			/* nothing to sweep */
		}
	}

	// --------------------------------------------------------------- pieces

	/** spec/03-profiles.md §6 — the resolved profile behind an agent conversation. */
	private resolveAgent(row: ConversationRow): ResolvedProfile {
		if (!row.profile_id || !row.workspace_id) {
			throw new ApiError(
				"profile_not_found",
				"This conversation's profile was deleted, so it can no longer run.",
			);
		}
		return this.services.profiles.resolve(row.profile_id);
	}

	/** Every append emits a visible notice in the transcript (spec/03-profiles.md §5.3). */
	private memoryToolFor(conversationId: string, agent: ResolvedProfile): unknown {
		return createMemoryTool({
			profileId: agent.profile.id,
			profileName: agent.profile.name,
			path: agent.memory.path,
			store: this.services.memory,
			nowIso: () => new Date().toISOString(),
			onNotice: (text) => this.hub.notify(conversationId, { type: "notice", level: "info", text }),
		});
	}

	/** spec/05-skills-and-tools.md §B.4 — chat mode's resolved tool names. */
	private resolvedToolNames(row: ConversationRow): string[] {
		const resolved = this.services.tools.resolveChat({ webSearch: row.web_search === 1 });
		return resolveChatTools({ webSearch: row.web_search === 1, available: resolved.toolNames });
	}

	private resolvedTools(row: ConversationRow) {
		const names = new Set(
			row.mode === "agent" && row.profile_id
				? this.services.profiles.resolve(row.profile_id).toolNames
				: this.resolvedToolNames(row),
		);
		// Preserve the resolved order: the Tools panel is the user's ground truth.
		const catalog = this.services.tools.list();
		return [...names].flatMap((name) => catalog.filter((tool) => tool.name === name));
	}

	private scratchDir(conversationId: string): string {
		return join(this.ctx.config.paths.scratch, conversationId);
	}

	private systemPromptFor(row: ConversationRow): string {
		if (row.mode === "agent") {
			// Fallback only: the real prompt comes from the live session (spec/09-api.md §8).
			if (!row.profile_id) return "This conversation's profile was deleted.";
			return this.services.profiles
				.resolve(row.profile_id)
				.agentsFiles.map((file) => file.content)
				.join("\n\n");
		}
		return buildChatSystemPrompt({
			webSearch: row.web_search === 1,
			date: this.ctx.clock.nowIso().slice(0, 10),
			timezone: row.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	}

	private async autoTitle(row: ConversationRow, firstMessage: string): Promise<void> {
		const model = this.services.models.getModel(row.provider, row.model_id);
		const title = model
			? await generateTitle(this.services.modelRuntime, model, firstMessage)
			: fallbackTitle(firstMessage);
		if (this.ctx.repos.conversations.setAutoTitle(row.id, title)) {
			this.services.events.emit({
				type: "conversation_title",
				conversationId: row.id,
				title,
			});
			this.hub.peek(row.id)?.emit({ type: "title", title });
		}
	}

	/** Transcript projection for an offline conversation (no live session). */
	projectMessages(messages: readonly unknown[], ids: Parameters<typeof projectTranscript>[1]) {
		return projectTranscript(messages, ids);
	}
}
