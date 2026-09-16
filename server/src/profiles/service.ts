// Profile domain: CRUD with filesystem side effects, validation, and the resolution pipeline
// that agent mode feeds to pi. spec/03-profiles.md, spec/09-api.md §4.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	CreateProfileRequest,
	PatchProfileRequest,
	Principal,
	Profile,
	ProfileDetail,
	ProfileMemoryResponse,
	ProfileSummary,
	ThinkingLevel,
	ToolDescriptor,
} from "@piui/shared";
import type { AppContext } from "../context.js";
import type { ProfileRow } from "../db/repositories/profiles.js";
import { ApiError } from "../http/errors.js";
import type { PiSkill, SkillCatalog } from "../skills/catalog.js";
import type { ToolRegistry } from "../tools/registry.js";
import { validateWorkspacePath } from "../workspaces/paths.js";
import { buildMemoryBlock, type MemoryStore, parseMemory } from "./memory.js";

export const AGENTS_MD_MAX_BYTES = 256 * 1024;

/** spec/03-profiles.md §6 — the input to `createAgentSession`. */
export interface ResolvedProfile {
	profile: ProfileRow;
	agentsFiles: { path: string; content: string }[];
	skills: PiSkill[];
	builtinToolNames: string[];
	customToolNames: string[];
	/** The union handed to pi as the allowlist (spike plan/spikes/08). */
	toolNames: string[];
	memory: { enabled: boolean; path: string; injectedBytes: number; sizeBytes: number };
	warnings: string[];
}

export interface ProfileServiceDeps {
	tools: ToolRegistry;
	skills: SkillCatalog;
	memory: MemoryStore;
}

export class ProfileService {
	readonly memory: MemoryStore;

	constructor(
		private readonly ctx: AppContext,
		private readonly deps: ProfileServiceDeps,
	) {
		this.memory = deps.memory;
	}

	// ----------------------------------------------------------------- read

	list(principal: Principal): ProfileSummary[] {
		return this.ctx.repos.profiles.list(principal).map((row) => {
			const { agentsMd, ...rest } = this.view(principal, row);
			return {
				...rest,
				agentsMdSize: Buffer.byteLength(agentsMd),
				usedByConversations: this.ctx.repos.conversations.countUsingProfile(principal, row.id),
			};
		});
	}

	get(principal: Principal, id: string): ProfileDetail {
		return this.detail(principal, this.getRow(principal, id));
	}

	/** Unscoped read for the session factory (no request principal). */
	getRowById(id: string): ProfileRow | undefined {
		return this.ctx.repos.profiles.getById(id);
	}

	// --------------------------------------------------------------- mutate

	create(principal: Principal, body: CreateProfileRequest): ProfileDetail {
		this.validate(principal, body, null);
		const row = this.ctx.repos.profiles.create(principal, {
			name: body.name,
			...(body.description === undefined ? {} : { description: body.description }),
			memoryEnabled: body.memory?.enabled === true,
			memoryPath: body.memory?.path ?? null,
			...(body.defaults?.provider && body.defaults.modelId
				? { defaultModel: `${body.defaults.provider}/${body.defaults.modelId}` }
				: {}),
			...(body.defaults?.thinkingLevel ? { defaultThinking: body.defaults.thinkingLevel } : {}),
		});
		this.writeAgentsMd(row.id, body.agentsMd ?? "");
		this.ctx.repos.profiles.setTools(principal, row.id, body.toolNames ?? []);
		this.ctx.repos.skills.setProfileSkills(row.id, body.skillIds ?? []);
		return this.detail(principal, this.ctx.repos.profiles.get(principal, row.id)!);
	}

	patch(principal: Principal, id: string, body: PatchProfileRequest): ProfileDetail {
		const row = this.ctx.repos.profiles.getForWrite(principal, id);
		this.validate(principal, body, row);
		this.ctx.repos.profiles.update(principal, id, {
			...(body.name === undefined ? {} : { name: body.name }),
			...(body.description === undefined ? {} : { description: body.description }),
			...(body.memory === undefined
				? {}
				: { memoryEnabled: body.memory.enabled, memoryPath: body.memory.path ?? null }),
			...(body.defaults === undefined
				? {}
				: {
						defaultModel:
							body.defaults.provider && body.defaults.modelId
								? `${body.defaults.provider}/${body.defaults.modelId}`
								: null,
						defaultThinking: body.defaults.thinkingLevel ?? null,
					}),
		});
		if (body.agentsMd !== undefined) this.writeAgentsMd(id, body.agentsMd);
		if (body.toolNames !== undefined)
			this.ctx.repos.profiles.setTools(principal, id, body.toolNames);
		if (body.skillIds !== undefined) this.ctx.repos.skills.setProfileSkills(id, body.skillIds);
		return this.detail(principal, this.ctx.repos.profiles.get(principal, id)!);
	}

	/** §7: conversations keep working, they just lose the profile. The directory goes to trash. */
	delete(principal: Principal, id: string): { affectedConversations: number } {
		this.ctx.repos.profiles.getForWrite(principal, id);
		const affectedConversations = this.ctx.repos.conversations.detachProfile(id);
		this.ctx.repos.profiles.delete(principal, id);
		this.toTrash(this.dirOf(id), id);
		return { affectedConversations };
	}

	duplicate(principal: Principal, id: string): ProfileDetail {
		const row = this.getRow(principal, id);
		let name = `${row.name} copy`;
		for (let n = 2; this.ctx.repos.profiles.findByName(name); n += 1)
			name = `${row.name} copy ${n}`;
		return this.create(principal, {
			name,
			description: row.description,
			agentsMd: this.readAgentsMd(row.id),
			skillIds: this.ctx.repos.skills.skillIdsOfProfile(row.id),
			toolNames: this.ctx.repos.profiles.toolNames(principal, row.id),
			memory: { enabled: row.memory_enabled === 1, path: row.memory_path },
		});
	}

	/** spec/03-profiles.md §1 — seeds on first boot only; they are ordinary rows afterwards. */
	seedIfEmpty(): void {
		if (this.ctx.repos.profiles.count() > 0) return;
		const owner: Principal = {
			id: this.ctx.repos.users.adminId(),
			username: "seed",
			displayName: "seed",
			roles: ["admin"],
		};
		const seeds: CreateProfileRequest[] = [
			{
				name: "Coding agent",
				description: "Reads, writes and runs code in a workspace.",
				agentsMd:
					"# Role\n\nYou are a concise engineering assistant working in the user's repository.\n\n" +
					"# Constraints\n\n- Prefer the smallest change that works.\n" +
					"- Read before you edit; run the project's own checks when they exist.\n",
				toolNames: ["read", "write", "edit", "bash", "grep", "find", "ls"],
			},
			{
				name: "Read-only reviewer",
				description: "Inspects a workspace without changing anything.",
				agentsMd: "# Role\n\nYou review code. You never modify files.\n",
				toolNames: ["read", "grep", "find", "ls"],
			},
			{
				name: "Researcher",
				description: "Searches the web and takes durable notes.",
				agentsMd: "# Role\n\nYou research topics and record what you learn.\n",
				toolNames: ["read", "write", "web_search", "web_fetch"],
				memory: { enabled: true },
			},
		];
		for (const seed of seeds) {
			try {
				this.create(owner, seed);
			} catch {
				/* a half-seeded home must not block boot */
			}
		}
	}

	// --------------------------------------------------------------- memory

	memoryPath(row: ProfileRow): string {
		return row.memory_path ?? join(this.dirOf(row.id), "memory.md");
	}

	readMemory(principal: Principal, id: string): ProfileMemoryResponse {
		const row = this.getRow(principal, id);
		const path = this.memoryPath(row);
		const stat = this.memory.stat(path);
		const content = this.memory.read(path);
		const block = buildMemoryBlock(row.name, content);
		return {
			path,
			enabled: row.memory_enabled === 1,
			sizeBytes: stat.sizeBytes,
			modifiedAt: stat.modifiedAt,
			content: content.slice(0, 512 * 1024),
			truncated: block.truncated,
			injectedBytes: content.length === 0 ? 0 : block.injectedBytes,
			noteCount: parseMemory(content).sections.reduce((n, s) => n + s.notes.length, 0),
		};
	}

	writeMemory(principal: Principal, id: string, content: string): { sizeBytes: number } {
		const row = this.ctx.repos.profiles.getForWrite(principal, id);
		const path = this.memoryPath(row);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, { mode: 0o600 });
		return { sizeBytes: Buffer.byteLength(content) };
	}

	/** "Clear memory" moves the file to trash — the human's notes are never rm -rf'd (§5.4). */
	clearMemory(principal: Principal, id: string): void {
		const row = this.ctx.repos.profiles.getForWrite(principal, id);
		const path = this.memoryPath(row);
		if (!existsSync(path)) return;
		const target = join(
			this.ctx.config.paths.trash,
			`${id}-memory-${this.ctx.clock.nowIso().replace(/[:.]/g, "-")}`,
		);
		mkdirSync(target, { recursive: true });
		renameSync(path, join(target, basename(path)));
	}

	// ------------------------------------------------------------- resolve

	/**
	 * spec/03-profiles.md §6 — `resolveProfile` → `resolveSkills` → `resolveTools` →
	 * `buildAgentsFiles`. The single source of truth for what an agent session gets.
	 */
	resolve(profileId: string): ResolvedProfile {
		const row = this.ctx.repos.profiles.getById(profileId);
		if (!row) throw new ApiError("profile_not_found", `No profile ${profileId}.`);
		const warnings: string[] = [];

		const skillIds = this.ctx.repos.skills.skillIdsOfProfile(row.id);
		const skills = this.deps.skills.resolve(skillIds);
		warnings.push(...skills.warnings);

		const memoryEnabled = row.memory_enabled === 1;
		const tools = this.deps.tools.resolveTools({
			mode: "agent",
			webSearch: false,
			profile: { toolNames: this.ctx.repos.profiles.toolNamesById(row.id), memoryEnabled },
		});
		warnings.push(...tools.warnings);

		const agentsFiles: { path: string; content: string }[] = [];
		const agentsMd = this.readAgentsMd(row.id);
		if (agentsMd.trim().length > 0) {
			agentsFiles.push({ path: join(this.dirOf(row.id), "AGENTS.md"), content: agentsMd });
		}

		const memoryPath = this.memoryPath(row);
		let injectedBytes = 0;
		let sizeBytes = 0;
		if (memoryEnabled) {
			const content = this.memory.read(memoryPath);
			sizeBytes = Buffer.byteLength(content);
			if (content.trim().length > 0) {
				const block = buildMemoryBlock(row.name, content);
				injectedBytes = block.injectedBytes;
				agentsFiles.push({ path: memoryPath, content: block.content });
				if (block.truncated) {
					warnings.push(
						`Memory is larger than the 32 KB injection budget; only the most recent notes are in context.`,
					);
				}
			}
		}

		return {
			profile: row,
			agentsFiles,
			skills: skills.skills,
			builtinToolNames: tools.builtinToolNames,
			customToolNames: tools.customToolNames,
			toolNames: tools.toolNames,
			memory: { enabled: memoryEnabled, path: memoryPath, injectedBytes, sizeBytes },
			warnings,
		};
	}

	resolvedToolDescriptors(toolNames: readonly string[]): ToolDescriptor[] {
		const names = new Set(toolNames);
		return this.deps.tools.list().filter((tool) => names.has(tool.name));
	}

	// --------------------------------------------------------------- pieces

	private getRow(principal: Principal, id: string): ProfileRow {
		const row = this.ctx.repos.profiles.get(principal, id);
		if (!row) throw new ApiError("not_found", `No profile ${id}.`);
		return row;
	}

	private dirOf(id: string): string {
		return join(this.ctx.config.paths.profiles, id);
	}

	/** The file is the source of truth: an external edit wins over anything cached (§2). */
	readAgentsMd(id: string): string {
		try {
			return readFileSync(join(this.dirOf(id), "AGENTS.md"), "utf8");
		} catch {
			return "";
		}
	}

	private writeAgentsMd(id: string, content: string): void {
		mkdirSync(this.dirOf(id), { recursive: true });
		writeFileSync(join(this.dirOf(id), "AGENTS.md"), content);
	}

	private toTrash(dir: string, id: string): void {
		if (!existsSync(dir)) return;
		const target = join(
			this.ctx.config.paths.trash,
			`${id}-${this.ctx.clock.nowIso().replace(/[:.]/g, "-")}`,
		);
		mkdirSync(this.ctx.config.paths.trash, { recursive: true });
		try {
			renameSync(dir, target);
		} catch {
			// cross-device: copy then remove, still never a blind rm -rf of a live directory
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "AGENTS.md"), this.readAgentsMd(id));
			rmSync(dir, { recursive: true, force: true });
		}
	}

	private view(principal: Principal, row: ProfileRow): Profile {
		const [provider, modelId] = (row.default_model ?? "").split("/");
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			agentsMd: this.readAgentsMd(row.id),
			skillIds: this.ctx.repos.skills.skillIdsOfProfile(row.id),
			toolNames: this.ctx.repos.profiles.toolNamesById(row.id),
			memory: {
				enabled: row.memory_enabled === 1,
				path: row.memory_path,
				sizeBytes: this.memory.stat(this.memoryPath(row)).sizeBytes,
			},
			...(row.default_model || row.default_thinking
				? {
						defaults: {
							...(provider ? { provider } : {}),
							...(modelId ? { modelId } : {}),
							...(row.default_thinking
								? { thinkingLevel: row.default_thinking as ThinkingLevel }
								: {}),
						},
					}
				: {}),
			ownerId: row.owner_id,
			visibility: row.visibility as "private" | "shared",
			isOwn: row.owner_id === principal.id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private detail(principal: Principal, row: ProfileRow): ProfileDetail {
		const profile = this.view(principal, row);
		const resolved = this.resolve(row.id);
		return {
			...profile,
			agentsMdSize: Buffer.byteLength(profile.agentsMd),
			usedByConversations: this.ctx.repos.conversations.countUsingProfile(principal, row.id),
			resolvedTools: this.resolvedToolDescriptors(resolved.toolNames),
			warnings: resolved.warnings,
		};
	}

	/** spec/03-profiles.md §7 — every write goes through this table. */
	private validate(
		principal: Principal,
		body: PatchProfileRequest,
		current: ProfileRow | null,
	): void {
		if (body.name !== undefined) {
			if (body.name.trim().length === 0 || body.name.length > 60) {
				throw new ApiError("validation_error", "A profile name is 1–60 characters.");
			}
			const clash = this.ctx.repos.profiles.findByName(body.name);
			if (clash && clash.id !== current?.id) {
				throw new ApiError("profile_name_taken", `A profile named "${body.name}" already exists.`);
			}
		}
		if (body.agentsMd !== undefined && Buffer.byteLength(body.agentsMd) > AGENTS_MD_MAX_BYTES) {
			throw new ApiError("agents_md_too_large", "AGENTS.md is limited to 256 KB.");
		}
		if (body.toolNames !== undefined) {
			const unknown = body.toolNames.filter((name) => !this.deps.tools.knows(name));
			if (unknown.length > 0) {
				throw new ApiError("validation_error", `Unknown tools: ${unknown.join(", ")}.`);
			}
			const implicit = body.toolNames.filter(
				(name) => this.deps.tools.get(name)?.selectableInProfile === false,
			);
			if (implicit.length > 0) {
				throw new ApiError(
					"validation_error",
					`${implicit.join(", ")} cannot be selected directly; it follows the memory setting.`,
				);
			}
		}
		if (body.skillIds !== undefined) {
			const unknown = body.skillIds.filter((id) => !this.ctx.repos.skills.getById(id));
			if (unknown.length > 0) {
				throw new ApiError("validation_error", `Unknown skills: ${unknown.join(", ")}.`);
			}
			const skillIds = body.skillIds;
			const toolNames =
				body.toolNames ?? (current ? this.ctx.repos.profiles.toolNamesById(current.id) : []);
			if (skillIds.length > 0 && !toolNames.includes("read") && !toolNames.includes("bash")) {
				throw new ApiError(
					"validation_error",
					"Skills require the `read` tool so the agent can load them.",
					[{ path: "skillIds", message: "skills_require_read" }],
				);
			}
		}
		if (body.memory?.path) {
			// A custom memory path passes the same validation as a workspace (§1).
			const check = validateWorkspacePath(dirname(body.memory.path), {
				home: homedir(),
				piuiHome: this.ctx.config.home,
				installDir: process.cwd(),
				roots: this.ctx.config.workspaceRoots,
			});
			if (!check.ok) throw new ApiError("path_not_allowed", check.message);
		}
		void principal;
	}
}

/** Size of a profile directory's memory file, for the list view. */
export function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
