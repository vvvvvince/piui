// Extension domain: enumeration by load probe, persistence, install flows and resolution.
// spec/16-extensions.md §§2, 3, 4, 7.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
	CreateExtensionRequest,
	DeleteExtensionResponse,
	ExtensionDetail,
	ExtensionRescanResponse,
	ExtensionSummary,
	ExtensionsResponse,
	FetchExtensionResponse,
} from "@piui/shared";
import type { AppContext } from "../context.js";
import type { ExtensionRow } from "../db/repositories/extensions.js";
import { ApiError } from "../http/errors.js";
import { BlockedUrlError, safeFetch, systemLookup } from "../net/ssrf.js";
import { probeExtensions } from "../pi/extensions.js";
import { type ExtensionRecord, resolveExtensions } from "./resolve.js";

export const MAX_EXTENSION_BYTES = 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ExtensionServiceDeps {
	/** Emitted after anything changed, so open clients refetch (spec §4, step 3). */
	onChanged?(): void;
}

export class ExtensionService {
	constructor(
		private readonly ctx: AppContext,
		private readonly deps: ExtensionServiceDeps = {},
	) {}

	// ------------------------------------------------------------- reading

	/**
	 * Registration + probe in one pass. Like M5b's skill discovery it runs on every read: the
	 * filesystem stays the source of truth and there is no boot ordering to get wrong.
	 */
	async sync(): Promise<{
		added: number;
		updated: number;
		removed: number;
		errors: { path: string; error: string }[];
	}> {
		let added = 0;
		let removed = 0;
		const known = new Map(this.ctx.repos.extensions.all().map((row) => [row.path, row]));

		// Managed files live in $PIUI_HOME/extensions; the user's own pi dir is auto-registered
		// as `external` (spec §2.2) — never edited, never deleted by piui.
		for (const [dir, source] of [
			[this.ctx.config.paths.extensions, "managed"],
			[join(this.ctx.config.userAgentDir, "extensions"), "external"],
		] as const) {
			for (const path of tsFilesIn(dir)) {
				if (known.has(path)) continue;
				const name = basename(path, ".ts");
				if (!NAME_RE.test(name) || this.ctx.repos.extensions.findByName(name)) continue;
				this.ctx.repos.extensions.insert({
					name,
					path,
					source,
					origin: source === "external" ? path : null,
				});
				added += 1;
			}
		}
		// A registered file that vanished: managed rows are dropped, external ones too — the row
		// carries no user state beyond the opt-out list, which cascades.
		for (const row of this.ctx.repos.extensions.all()) {
			if (existsSync(row.path)) continue;
			this.ctx.repos.extensions.delete(row.id);
			removed += 1;
		}

		const rows = this.ctx.repos.extensions.all().filter((row) => row.enabled === 1);
		const result = await probeExtensions({
			paths: rows.map((row) => row.path),
			cwd: this.ctx.config.paths.scratch,
			agentDir: this.ctx.config.agentDir,
		});
		const loaded = new Map(result.loaded.map((entry) => [entry.path, entry]));
		const errors = new Map(result.errors.map((entry) => [entry.path, entry.error]));
		let updated = 0;
		for (const row of rows) {
			const hit = loaded.get(row.path);
			const changed = this.ctx.repos.extensions.recordProbe(row.id, {
				tools: hit?.tools ?? [],
				commands: hit?.commands ?? [],
				loadError: hit ? null : (errors.get(row.path) ?? "Extension did not load."),
			});
			if (changed && added === 0) updated += 1;
		}
		if (added + updated + removed > 0) this.deps.onChanged?.();
		return { added, updated, removed, errors: result.errors };
	}

	async list(): Promise<ExtensionsResponse> {
		await this.sync();
		const counts = this.ctx.repos.extensions.disabledCounts();
		return {
			items: this.ctx.repos.extensions
				.all()
				.map((row) => this.summary(row, counts.get(row.id) ?? 0)),
			installEnabled: !this.ctx.config.disableExtensionInstall,
		};
	}

	async get(id: string): Promise<ExtensionDetail> {
		const row = this.rowOrThrow(id);
		const counts = this.ctx.repos.extensions.disabledCounts();
		return {
			...this.summary(row, counts.get(row.id) ?? 0),
			source_text: row.source === "managed" ? safeRead(row.path) : null,
		};
	}

	/** The records resolution runs on (also used by the tool catalog). */
	records(): ExtensionRecord[] {
		return this.ctx.repos.extensions.all().map(toRecord);
	}

	/** spec §3 — the paths + tool/command names a conversation gets. Pure beyond this read. */
	resolveFor(options: { profileId?: string | null; builtinNames?: readonly string[] }) {
		const disabledIds = options.profileId
			? this.ctx.repos.extensions.disabledIdsOfProfile(options.profileId)
			: [];
		return resolveExtensions({
			all: this.records(),
			disabledIds,
			...(options.builtinNames ? { builtinNames: options.builtinNames } : {}),
		});
	}

	/**
	 * spec/16-extensions.md §4 — "allow tools registered at runtime": pi's allowlist is fixed at
	 * session construction (spike S9 §5), so a name first seen during `session_start` is cached
	 * here and admitted by the *next* session — the spec's "once seen".
	 */
	rememberObservedTools(paths: readonly string[], observed: readonly string[]): void {
		if (paths.length !== 1) return; // with several loaded, the owner of a new name is ambiguous
		const row = this.ctx.repos.extensions.findByPath(paths[0]!);
		if (!row) return;
		const known = parseList(row.tools_json);
		const added = observed.filter((name) => !known.includes(name));
		if (added.length === 0) return;
		this.ctx.repos.extensions.recordProbe(row.id, {
			tools: [...known, ...added],
			commands: parseList(row.commands_json),
			loadError: null,
		});
		this.deps.onChanged?.();
	}

	// ------------------------------------------------------------ mutation

	/** Paste / upload (`name` + `source`) or register an external path. */
	async install(body: CreateExtensionRequest): Promise<ExtensionSummary> {
		this.requireInstallEnabled();
		if (body.path) return this.registerPath(body.path);
		const source = body.source ?? "";
		const name = (body.name ?? "").trim();
		if (!NAME_RE.test(name)) {
			throw new ApiError(
				"validation_error",
				"An extension name is lowercase letters, digits, dot, dash or underscore (max 64).",
			);
		}
		if (Buffer.byteLength(source) > MAX_EXTENSION_BYTES) {
			throw new ApiError("extension_too_large", "An extension source is limited to 1 MB.");
		}
		if (source.trim().length === 0) {
			throw new ApiError("validation_error", "The extension source is empty.");
		}
		if (this.ctx.repos.extensions.findByName(name)) {
			throw new ApiError("extension_name_taken", `An extension named "${name}" already exists.`);
		}
		const path = join(this.ctx.config.paths.extensions, `${name}.ts`);
		const probe = await this.probeCandidate(name, source);
		mkdirSync(this.ctx.config.paths.extensions, { recursive: true });
		writeFileSync(path, source);
		const row = this.ctx.repos.extensions.insert({
			name,
			path,
			source: "managed",
			origin: body.origin ?? null,
		});
		this.ctx.repos.extensions.recordProbe(row.id, {
			tools: probe.tools,
			commands: probe.commands,
			loadError: null,
		});
		this.deps.onChanged?.();
		return this.summary(this.ctx.repos.extensions.getById(row.id)!, 0);
	}

	/** spec §7.1 — fetch-then-review: the source comes back, nothing is installed. */
	async fetchSource(url: string): Promise<FetchExtensionResponse> {
		this.requireInstallEnabled();
		if (!url.startsWith("https://")) {
			throw new ApiError("validation_error", "Only https:// URLs can be fetched.");
		}
		let result: Awaited<ReturnType<typeof safeFetch>>;
		try {
			result = await safeFetch(url, {
				fetch: this.ctx.fetch,
				lookup: systemLookup,
				maxBytes: MAX_EXTENSION_BYTES,
				allowPrivate: this.ctx.config.allowPrivateHttpTools,
			});
		} catch (error) {
			throw new ApiError(
				error instanceof BlockedUrlError ? "path_not_allowed" : "validation_error",
				(error as Error).message,
			);
		}
		if (result.truncated) {
			throw new ApiError("extension_too_large", "An extension source is limited to 1 MB.");
		}
		const source = result.body;
		const base = basename(new URL(url).pathname).replace(/\.ts$/, "").toLowerCase();
		const name = NAME_RE.test(base) ? base : "extension";
		return {
			name,
			source,
			sha256: createHash("sha256").update(source).digest("hex"),
			bytes: Buffer.byteLength(source),
		};
	}

	async patch(id: string, body: { enabled?: boolean; source?: string }): Promise<ExtensionSummary> {
		this.requireInstallEnabled();
		const row = this.rowOrThrow(id);
		if (body.source !== undefined) {
			if (row.source !== "managed") {
				throw new ApiError(
					"extension_not_editable",
					"External extensions are read-only: piui never edits files it does not own.",
				);
			}
			if (Buffer.byteLength(body.source) > MAX_EXTENSION_BYTES) {
				throw new ApiError("extension_too_large", "An extension source is limited to 1 MB.");
			}
			const probe = await this.probeCandidate(row.name, body.source);
			writeFileSync(row.path, body.source);
			this.ctx.repos.extensions.recordProbe(row.id, {
				tools: probe.tools,
				commands: probe.commands,
				loadError: null,
			});
		}
		if (body.enabled !== undefined) this.ctx.repos.extensions.setEnabled(id, body.enabled);
		this.deps.onChanged?.();
		const counts = this.ctx.repos.extensions.disabledCounts();
		return this.summary(this.ctx.repos.extensions.getById(id)!, counts.get(id) ?? 0);
	}

	async remove(id: string): Promise<DeleteExtensionResponse> {
		this.requireInstallEnabled();
		const row = this.rowOrThrow(id);
		const response: DeleteExtensionResponse = {
			affectedProfiles: this.ctx.repos.extensions.profilesDisabling(id),
			removedTools: parseList(row.tools_json),
			removedCommands: parseList(row.commands_json),
		};
		if (row.source === "managed") {
			// spec §7.3: uninstall is a move to trash, never an unrecoverable delete.
			const trash = join(this.ctx.config.paths.trash, "extensions");
			mkdirSync(trash, { recursive: true });
			try {
				renameSync(row.path, join(trash, basename(row.path)));
			} catch {
				/* the file may already be gone */
			}
		}
		this.ctx.repos.extensions.delete(id);
		this.deps.onChanged?.();
		return response;
	}

	async rescan(): Promise<ExtensionRescanResponse> {
		this.requireInstallEnabled();
		const result = await this.sync();
		this.deps.onChanged?.();
		return result;
	}

	// --------------------------------------------------------------- pieces

	private requireInstallEnabled(): void {
		if (this.ctx.config.disableExtensionInstall) {
			throw new ApiError(
				"extension_install_disabled",
				"Extension installation is disabled on this server (PIUI_DISABLE_EXTENSION_INSTALL=1).",
			);
		}
	}

	private rowOrThrow(id: string): ExtensionRow {
		const row = this.ctx.repos.extensions.getById(id);
		if (!row) throw new ApiError("not_found", `No extension ${id}.`);
		return row;
	}

	/** spec §7.2.3 — the load probe runs *before* anything is written into `extensions/`. */
	private async probeCandidate(
		name: string,
		source: string,
	): Promise<{ tools: string[]; commands: string[] }> {
		// A fresh directory per probe: pi (like any ESM host) caches a module by path, so
		// re-probing the same path would return the previous, working, version.
		const dir = join(this.ctx.config.paths.scratch, `ext-probe-${this.ctx.ids.newId()}`);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const candidate = join(dir, `${name}.ts`);
		writeFileSync(candidate, source);
		const result = await probeExtensions({
			paths: [candidate],
			cwd: dir,
			agentDir: this.ctx.config.agentDir,
		});
		const failure = result.errors[0];
		if (failure || result.loaded.length === 0) {
			throw new ApiError(
				"extension_load_failed",
				failure?.error ?? "The extension did not register anything and failed to load.",
			);
		}
		return { tools: result.loaded[0]!.tools, commands: result.loaded[0]!.commands };
	}

	/** spec §7.1 — register an existing path (a file, or a directory of `*.ts`). */
	private async registerPath(path: string): Promise<ExtensionSummary> {
		if (!existsSync(path)) throw new ApiError("path_not_found", `${path} does not exist.`);
		const files = statSync(path).isDirectory() ? tsFilesIn(path) : [path];
		if (files.length === 0) {
			throw new ApiError("validation_error", `${path} holds no .ts extension file.`);
		}
		for (const file of files) {
			const name = basename(file, ".ts");
			if (!NAME_RE.test(name)) {
				throw new ApiError("validation_error", `"${name}" is not a valid extension name.`);
			}
			if (this.ctx.repos.extensions.findByPath(file)) continue;
			if (this.ctx.repos.extensions.findByName(name)) {
				throw new ApiError("extension_name_taken", `An extension named "${name}" already exists.`);
			}
			this.ctx.repos.extensions.insert({
				name,
				path: file,
				source: "external",
				origin: path,
			});
		}
		await this.sync();
		const counts = this.ctx.repos.extensions.disabledCounts();
		const row = this.ctx.repos.extensions.findByPath(files[0]!)!;
		return this.summary(row, counts.get(row.id) ?? 0);
	}

	private summary(row: ExtensionRow, disabledInProfiles: number): ExtensionSummary {
		return {
			id: row.id,
			name: row.name,
			source: row.source as "managed" | "external",
			origin: row.origin,
			path: row.path,
			enabled: row.enabled === 1,
			loadError: row.load_error,
			tools: parseList(row.tools_json),
			commands: parseList(row.commands_json),
			disabledInProfiles,
			editable: row.source === "managed",
		};
	}
}

function toRecord(row: ExtensionRow): ExtensionRecord {
	return {
		id: row.id,
		name: row.name,
		path: row.path,
		source: row.source as "managed" | "external",
		enabled: row.enabled === 1,
		loadError: row.load_error,
		tools: parseList(row.tools_json),
		commands: parseList(row.commands_json),
	};
}

function parseList(json: string): string[] {
	try {
		const parsed = JSON.parse(json) as unknown;
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function tsFilesIn(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => join(dir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

function safeRead(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
