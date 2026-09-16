// /profiles — the profile list and editor (spec/03-profiles.md §§2-5, spec/10-frontend.md §2).
// AGENTS.md is edited in a plain textarea with a counter; a CodeMirror upgrade is M6's call.
import type { ProfileDetail, SkillSummary, ToolCatalogItem } from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ApiClientError, api } from "../api/client.js";

const AGENTS_MD_WARN_BYTES = 16 * 1024;
const kb = (bytes: number): string =>
	bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

type Tab = "instructions" | "tools" | "skills" | "extensions" | "memory";

export function ProfilesPage(): JSX.Element {
	const queryClient = useQueryClient();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
	const create = useMutation({
		mutationFn: (name: string) => api.createProfile({ name, toolNames: ["read", "ls", "grep"] }),
		onSuccess: (profile) => {
			void queryClient.invalidateQueries({ queryKey: ["profiles"] });
			setCreating(false);
			setSelectedId(profile.id);
		},
	});

	return (
		<div className="grid gap-4 p-4 md:grid-cols-[20rem_1fr]">
			<section>
				<div className="mb-2 flex items-center justify-between">
					<h1 className="text-lg font-semibold">Profiles</h1>
					<button
						type="button"
						className="rounded bg-sky-700 px-2 py-1 text-sm"
						onClick={() => setCreating(true)}
					>
						New profile
					</button>
				</div>
				{profiles.isPending && <p className="text-sm text-slate-400">Loading…</p>}
				<ul className="space-y-2">
					{profiles.data?.items.map((profile) => (
						<li key={profile.id}>
							<button
								type="button"
								className={`w-full rounded border p-2 text-left ${
									profile.id === selectedId
										? "border-sky-700 bg-slate-900"
										: "border-slate-800 hover:border-slate-700"
								}`}
								onClick={() => setSelectedId(profile.id)}
							>
								<span className="block text-sm font-medium">{profile.name}</span>
								<span className="block truncate text-xs text-slate-400">
									{profile.description || "No description"}
								</span>
								<span className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
									<span>{profile.toolNames.length} tools</span>
									{profile.memory.enabled && <span className="text-emerald-400">memory on</span>}
									{profile.usedByConversations > 0 && (
										<span>{profile.usedByConversations} conversations</span>
									)}
									<span>{kb(profile.agentsMdSize)} AGENTS.md</span>
								</span>
							</button>
						</li>
					))}
				</ul>
				{profiles.data?.items.length === 0 && (
					<p className="text-sm text-slate-400">No profiles yet.</p>
				)}
			</section>

			<section>
				{selectedId ? (
					<ProfileEditor
						key={selectedId}
						profileId={selectedId}
						onDeleted={() => setSelectedId(null)}
					/>
				) : (
					<p className="text-sm text-slate-400">Select a profile to edit it.</p>
				)}
			</section>

			{creating && (
				<NewProfileDialog
					onClose={() => setCreating(false)}
					onCreate={(name) => create.mutate(name)}
					error={create.error as ApiClientError | null}
					pending={create.isPending}
				/>
			)}
		</div>
	);
}

function NewProfileDialog({
	onClose,
	onCreate,
	error,
	pending,
}: {
	onClose(): void;
	onCreate(name: string): void;
	error: ApiClientError | null;
	pending: boolean;
}): JSX.Element {
	const [name, setName] = useState("");
	return (
		<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
			<div
				role="dialog"
				aria-label="New profile"
				className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4"
			>
				<h2 className="mb-2 text-lg font-semibold">New profile</h2>
				<label className="block text-sm">
					Name
					<input
						className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				{error && <p className="mt-2 text-sm text-rose-400">{error.message}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" className="rounded px-3 py-1.5 text-sm" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="rounded bg-sky-700 px-3 py-1.5 text-sm disabled:opacity-40"
						disabled={name.trim().length === 0 || pending}
						onClick={() => onCreate(name.trim())}
					>
						Create
					</button>
				</div>
			</div>
		</div>
	);
}

function ProfileEditor({
	profileId,
	onDeleted,
}: {
	profileId: string;
	onDeleted(): void;
}): JSX.Element {
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<Tab>("instructions");
	const [deleting, setDeleting] = useState(false);
	const [agentsMd, setAgentsMd] = useState<string | null>(null);

	const profile = useQuery({
		queryKey: ["profile", profileId],
		queryFn: () => api.profile(profileId),
	});
	const tools = useQuery({ queryKey: ["tools"], queryFn: api.tools });
	const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
	// spec/16-extensions.md §7.3 — installed globally, switched off per profile.
	const extensions = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
	// spec/15-commands-and-input.md §3.2 — the visible price of TUI parity. pi loads every
	// discovered skill's name + description into every request; ~4 chars per token.
	const discoveredSkills = (skills.data?.items ?? []).filter((s) => s.source === "external");
	const discoveredCount = discoveredSkills.length;
	const discoveredTokens = Math.ceil(
		discoveredSkills.reduce((sum, s) => sum + s.name.length + s.description.length + 20, 0) / 4,
	);

	// The file on disk wins, so the editor starts from what the server just read (§2).
	useEffect(() => {
		if (profile.data && agentsMd === null) setAgentsMd(profile.data.agentsMd);
	}, [profile.data, agentsMd]);

	const save = useMutation({
		mutationFn: (patch: Parameters<typeof api.patchProfile>[1]) =>
			api.patchProfile(profileId, patch),
		onSuccess: (updated) => {
			queryClient.setQueryData(["profile", profileId], updated);
			void queryClient.invalidateQueries({ queryKey: ["profiles"] });
		},
	});
	const remove = useMutation({
		mutationFn: () => api.deleteProfile(profileId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["profiles"] });
			setDeleting(false);
			onDeleted();
		},
	});
	const duplicate = useMutation({
		mutationFn: () => api.duplicateProfile(profileId),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["profiles"] }),
	});

	if (!profile.data) return <p className="text-sm text-slate-400">Loading…</p>;
	const detail: ProfileDetail = profile.data;
	const selectable = (tools.data?.items ?? []).filter((tool) => tool.selectableInProfile);

	const toggleTool = (name: string, on: boolean): void => {
		const next = on
			? [...detail.toolNames, name]
			: detail.toolNames.filter((tool) => tool !== name);
		save.mutate({ toolNames: next });
	};

	return (
		<div>
			<header className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h2 className="text-lg font-semibold">{detail.name}</h2>
					<p className="text-xs text-slate-400">{detail.description || "No description"}</p>
				</div>
				<div className="flex gap-2 text-sm">
					<button
						type="button"
						className="rounded border border-slate-700 px-2 py-1"
						onClick={() => duplicate.mutate()}
					>
						Duplicate
					</button>
					<button
						type="button"
						className="rounded border border-rose-800 px-2 py-1 text-rose-300"
						onClick={() => setDeleting(true)}
					>
						Delete
					</button>
				</div>
			</header>

			{detail.warnings.length > 0 && (
				<ul className="mt-2 space-y-1">
					{detail.warnings.map((warning) => (
						<li
							key={warning}
							className="rounded border border-amber-800 bg-amber-950/40 px-2 py-1 text-xs text-amber-200"
						>
							{warning}
						</li>
					))}
				</ul>
			)}

			<div role="tablist" className="mt-3 flex gap-2 border-b border-slate-800 text-sm">
				{(["instructions", "tools", "skills", "extensions", "memory"] as Tab[]).map((name) => (
					<button
						key={name}
						role="tab"
						type="button"
						aria-selected={tab === name}
						className={`px-2 py-1 capitalize ${
							tab === name ? "border-b-2 border-sky-600 text-slate-100" : "text-slate-400"
						}`}
						onClick={() => setTab(name)}
					>
						{name}
					</button>
				))}
			</div>

			{tab === "instructions" && (
				<div className="mt-3">
					<textarea
						aria-label="AGENTS.md"
						className="h-64 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs"
						value={agentsMd ?? ""}
						onChange={(event) => setAgentsMd(event.target.value)}
					/>
					<div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
						<span>{(agentsMd ?? "").length} characters</span>
						{(agentsMd ?? "").length > AGENTS_MD_WARN_BYTES && (
							<span className="text-amber-400">
								large instructions consume context on every request
							</span>
						)}
						<button
							type="button"
							className="rounded bg-sky-700 px-2 py-1 text-slate-100"
							onClick={() => save.mutate({ agentsMd: agentsMd ?? "" })}
						>
							Save
						</button>
						{save.isError && (
							<span className="text-rose-400">{(save.error as ApiClientError).message}</span>
						)}
					</div>
				</div>
			)}

			{tab === "tools" && (
				<ul className="mt-3 space-y-1">
					{selectable.map((tool: ToolCatalogItem) => (
						<li key={tool.name} className="flex items-center gap-2 text-sm">
							<input
								id={`tool-${tool.name}`}
								type="checkbox"
								checked={detail.toolNames.includes(tool.name)}
								disabled={!tool.enabled}
								onChange={(event) => toggleTool(tool.name, event.target.checked)}
							/>
							<label htmlFor={`tool-${tool.name}`} className="flex items-center gap-2">
								<span className="font-mono text-xs">{tool.name}</span>
								<span className="text-slate-400">{tool.label}</span>
								{tool.dangerous && (
									<span className="rounded bg-rose-900 px-1 text-[10px] text-rose-200">
										dangerous — it can change files or run commands
									</span>
								)}
								{!tool.enabled && (
									<span className="text-[10px] text-amber-400">disabled on this server</span>
								)}
							</label>
						</li>
					))}
					{detail.memory.enabled && (
						<li className="flex items-center gap-2 text-sm text-slate-500">
							<input type="checkbox" checked disabled />
							<span className="font-mono text-xs">memory_append</span>
							<span>included because memory is on</span>
						</li>
					)}
				</ul>
			)}

			{tab === "skills" && (
				<ul className="mt-3 space-y-1">
					{(skills.data?.items ?? []).map((skill: SkillSummary) => (
						<li key={skill.id} className="flex items-center gap-2 text-sm">
							<input
								id={`skill-${skill.id}`}
								type="checkbox"
								checked={detail.skillIds.includes(skill.id)}
								onChange={(event) =>
									save.mutate({
										skillIds: event.target.checked
											? [...detail.skillIds, skill.id]
											: detail.skillIds.filter((id) => id !== skill.id),
									})
								}
							/>
							<label htmlFor={`skill-${skill.id}`}>
								<span className="font-mono text-xs">{skill.name}</span>{" "}
								{skill.location && (
									<span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">
										{skill.location}
									</span>
								)}{" "}
								<span className="text-slate-400">{skill.description}</span>
								{skill.missing && <span className="text-amber-400"> (missing on disk)</span>}
							</label>
						</li>
					))}
					<li className="mt-2 flex items-start gap-2 border-t border-slate-800 pt-2 text-sm">
						<input
							id="include-discovered"
							type="checkbox"
							checked={detail.includeDiscoveredSkills === true}
							onChange={(event) => save.mutate({ includeDiscoveredSkills: event.target.checked })}
						/>
						<label htmlFor="include-discovered">
							Include all discovered skills
							<span className="block text-xs text-slate-400">
								{discoveredCount} discovered skill{discoveredCount === 1 ? "" : "s"} from
								~/.pi/agent/skills and trusted workspaces — ~{discoveredTokens} tokens of system
								prompt when enabled (pi's TUI always loads them).
							</span>
						</label>
					</li>
					{(skills.data?.items.length ?? 0) === 0 && (
						<li className="text-sm text-slate-400">
							No skills yet — drop a folder with a SKILL.md into ~/.piui/skills.
						</li>
					)}
					{detail.skillIds.length > 0 &&
						!detail.toolNames.includes("read") &&
						!detail.toolNames.includes("bash") && (
							<li className="text-sm text-rose-400">
								Skills require the `read` tool so the agent can load them.
							</li>
						)}
				</ul>
			)}

			{tab === "extensions" && (
				<ul className="mt-3 space-y-1" data-testid="profile-extensions">
					<li className="text-xs text-slate-400">
						Extensions are installed globally. Here you can switch some off for this profile.
					</li>
					{(extensions.data?.items ?? []).map((extension) => (
						<li key={extension.id} className="flex items-center gap-2 text-sm">
							<input
								id={`profile-extension-${extension.name}`}
								data-testid={`profile-extension-${extension.name}`}
								type="checkbox"
								checked={!detail.disabledExtensionIds.includes(extension.id)}
								onChange={(event) =>
									save.mutate({
										disabledExtensionIds: event.target.checked
											? detail.disabledExtensionIds.filter((id) => id !== extension.id)
											: [...detail.disabledExtensionIds, extension.id],
									})
								}
							/>
							<label htmlFor={`profile-extension-${extension.name}`}>
								<span className="font-mono text-xs">{extension.name}</span>{" "}
								<span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">
									{extension.source}
								</span>{" "}
								<span className="text-slate-400">{extension.tools.join(", ") || "no tools"}</span>
								{!extension.enabled && <span className="text-amber-400"> (disabled globally)</span>}
								{extension.loadError && <span className="text-rose-400"> (failed to load)</span>}
							</label>
						</li>
					))}
					{(extensions.data?.items.length ?? 0) === 0 && (
						<li className="text-sm text-slate-400">No extensions installed.</li>
					)}
					<li className="mt-2 flex items-start gap-2 border-t border-slate-800 pt-2 text-sm">
						<input
							id="allow-dynamic-extension-tools"
							data-testid="allow-dynamic-extension-tools"
							type="checkbox"
							checked={detail.allowDynamicExtensionTools !== false}
							onChange={(event) =>
								save.mutate({ allowDynamicExtensionTools: event.target.checked })
							}
						/>
						<label htmlFor="allow-dynamic-extension-tools">
							Allow tools registered by extensions at runtime
							<span className="block text-xs text-slate-400">
								A tool an extension registers after startup is remembered the first time it is seen
								and allowed from the next conversation on.
							</span>
						</label>
					</li>
				</ul>
			)}

			{tab === "memory" && (
				<MemoryPanel
					profileId={profileId}
					enabled={detail.memory.enabled}
					onToggle={(enabled) => save.mutate({ memory: { enabled } })}
				/>
			)}

			{deleting && (
				<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
					<div
						role="dialog"
						aria-label="Delete profile"
						className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4"
					>
						<h3 className="text-lg font-semibold">Delete profile</h3>
						<p className="mt-2 text-sm text-slate-300">
							{detail.usedByConversations > 0
								? `${detail.usedByConversations} conversations use "${detail.name}". They keep their transcripts but cannot be prompted again.`
								: `"${detail.name}" is not used by any conversation.`}{" "}
							The profile folder is moved to trash, not deleted.
						</p>
						<div className="mt-4 flex justify-end gap-2">
							<button
								type="button"
								className="rounded px-3 py-1.5 text-sm"
								onClick={() => setDeleting(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="rounded bg-rose-700 px-3 py-1.5 text-sm"
								onClick={() => remove.mutate()}
							>
								Delete profile
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export function MemoryPanel({
	profileId,
	enabled,
	onToggle,
}: {
	profileId: string;
	enabled: boolean;
	onToggle(enabled: boolean): void;
}): JSX.Element {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<string | null>(null);
	const memory = useQuery({
		queryKey: ["profile-memory", profileId],
		queryFn: () => api.profileMemory(profileId),
	});
	const save = useMutation({
		mutationFn: (content: string) => api.putProfileMemory(profileId, content),
		onSuccess: () => {
			setDraft(null);
			void queryClient.invalidateQueries({ queryKey: ["profile-memory", profileId] });
		},
	});
	const clear = useMutation({
		mutationFn: () => api.clearProfileMemory(profileId),
		onSuccess: () =>
			void queryClient.invalidateQueries({ queryKey: ["profile-memory", profileId] }),
	});

	return (
		<div className="mt-3 space-y-2 text-sm">
			<label className="flex items-center gap-2">
				<input
					type="checkbox"
					checked={enabled}
					onChange={(event) => onToggle(event.target.checked)}
				/>
				Persistent memory {enabled ? "on" : "off"} — disabling keeps the file on disk
			</label>
			{memory.data && (
				<>
					<p className="text-xs text-slate-400">
						<span className="font-mono">{memory.data.path}</span> · {memory.data.noteCount} notes ·{" "}
						{memory.data.modifiedAt ?? "never written"}
					</p>
					<p className="text-xs text-slate-300">
						injecting {kb(memory.data.injectedBytes)} of {kb(memory.data.sizeBytes)}
						{memory.data.truncated && (
							<span className="ml-2 text-amber-400">
								memory truncated — only the newest notes are in context
							</span>
						)}
					</p>
					<p className="text-xs text-slate-500">
						Pinned notes are always injected starting in a future version; today the whole file's
						tail is injected, so `## Pinned` is only a place for you to organise notes.
					</p>
					<textarea
						aria-label="memory.md"
						className="h-48 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs"
						value={draft ?? memory.data.content}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<div className="flex gap-2 text-xs">
						<button
							type="button"
							className="rounded bg-sky-700 px-2 py-1"
							onClick={() => save.mutate(draft ?? memory.data.content)}
						>
							Save
						</button>
						<a
							className="rounded border border-slate-700 px-2 py-1"
							href={`/api/profiles/${profileId}/memory/download`}
						>
							Download .md
						</a>
						<button
							type="button"
							className="rounded border border-rose-800 px-2 py-1 text-rose-300"
							onClick={() => clear.mutate()}
						>
							Clear memory (moves the file to trash)
						</button>
					</div>
				</>
			)}
		</div>
	);
}
