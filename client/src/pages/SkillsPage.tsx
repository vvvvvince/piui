// /skills — spec/05-skills-and-tools.md §§A.2, A.4, A.5. List + editor (file tree, frontmatter
// form, body editor, validation panel), templates, import, rescan, in-app delete dialog.
import type { SkillDetail, SkillSummary, SkillTemplate } from "@piui/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type ApiClientError, api } from "../api/client.js";
import { CodeEditor } from "../components/CodeEditor.js";

const TEMPLATES: { id: SkillTemplate; label: string; hint: string }[] = [
	{ id: "basic", label: "Basic", hint: "instructions only" },
	{ id: "script", label: "Script", hint: "SKILL.md + scripts/run.sh" },
	{ id: "reference", label: "Reference", hint: "SKILL.md + references/*.md" },
];

export function SkillsPage(): JSX.Element {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const list = useQuery({ queryKey: ["skills"], queryFn: api.skills });
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<SkillSummary | null>(null);
	const [showNew, setShowNew] = useState(false);
	const [showImport, setShowImport] = useState(false);

	const fail = (err: unknown): void => setError((err as ApiClientError).message);
	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["skills"] });
		void queryClient.invalidateQueries({ queryKey: ["skill", selectedId] });
	};

	const rescan = useMutation({
		mutationFn: () => api.rescanSkills(),
		onMutate: () => setError(null),
		onSuccess: (result) => {
			setNotice(`${result.added} added · ${result.updated} known · ${result.missing} missing`);
			refresh();
		},
		onError: fail,
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteSkill(id),
		onMutate: () => setError(null),
		onSuccess: () => {
			setConfirmDelete(null);
			setSelectedId(null);
			refresh();
		},
		onError: fail,
	});
	const toggle = useMutation({
		mutationFn: (input: { id: string; enabled: boolean }) =>
			api.patchSkill(input.id, { enabled: input.enabled }),
		onMutate: () => setError(null),
		onSuccess: refresh,
		onError: fail,
	});

	const items = (list.data?.items ?? []).filter((skill) =>
		search.trim().length === 0
			? true
			: `${skill.name} ${skill.description}`.toLowerCase().includes(search.trim().toLowerCase()),
	);

	return (
		<div className="space-y-4 p-4">
			<header className="flex items-center justify-between gap-3">
				<div>
					<h1 className="text-lg font-semibold">Skills</h1>
					<p className="text-xs text-slate-500">
						Skills follow the Agent Skills standard. Managed skills live in
						<code className="mx-1 font-mono">$PIUI_HOME/skills</code>; discovered ones are
						read-only. Activation is per profile.
					</p>
				</div>
				<div className="flex shrink-0 gap-2 text-xs">
					<button
						type="button"
						data-testid="skill-new"
						className="rounded bg-sky-700 px-2 py-1"
						onClick={() => setShowNew(true)}
					>
						New skill
					</button>
					<button
						type="button"
						data-testid="skill-import"
						className="rounded bg-slate-700 px-2 py-1"
						onClick={() => setShowImport(true)}
					>
						Import
					</button>
					<button
						type="button"
						data-testid="skills-rescan"
						className="rounded bg-slate-700 px-2 py-1"
						onClick={() => rescan.mutate()}
					>
						Rescan
					</button>
				</div>
			</header>

			{notice && <p className="text-xs text-slate-400">{notice}</p>}
			{error && (
				<p data-testid="skills-error" className="text-xs text-rose-400">
					{error}
				</p>
			)}

			<input
				data-testid="skills-search"
				className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-sm"
				placeholder="Search skills"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
			/>

			<ul className="space-y-2" data-testid="skills-list">
				{items.map((skill) => (
					<li
						key={skill.id}
						data-testid={`skill-row-${skill.dirName}`}
						className="rounded border border-slate-800 bg-slate-900/40 p-3 text-sm"
					>
						<div className="flex items-start justify-between gap-3">
							<button
								type="button"
								className="min-w-0 flex-1 text-left"
								data-testid={`skill-open-${skill.dirName}`}
								onClick={() => setSelectedId(skill.id === selectedId ? null : skill.id)}
							>
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{skill.name}</span>
									<span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400">
										{skill.source}
										{skill.location ? ` · ${skill.location}` : ""}
									</span>
									{skill.missing && <span className="text-[11px] text-rose-400">⚠ missing</span>}
									{(skill.warnings?.length ?? 0) > 0 && (
										<span
											data-testid={`skill-warning-${skill.dirName}`}
											title={skill.warnings.join("\n")}
											className="text-[11px] text-amber-400"
										>
											⚠ {skill.warnings.length}
										</span>
									)}
								</div>
								<p className="truncate text-xs text-slate-400">{skill.description}</p>
								<p className="truncate font-mono text-[11px] text-slate-600">{skill.path}</p>
							</button>
							<div className="flex shrink-0 items-center gap-3 text-xs">
								<span className="text-slate-500">{skill.files?.length ?? 0} files</span>
								<span className="text-slate-500">
									used by {skill.usedByProfiles ?? 0} profile
									{(skill.usedByProfiles ?? 0) === 1 ? "" : "s"}
								</span>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										data-testid={`skill-enabled-${skill.dirName}`}
										checked={skill.enabled}
										onChange={(event) =>
											toggle.mutate({ id: skill.id, enabled: event.target.checked })
										}
									/>
									enabled
								</label>
								<button
									type="button"
									data-testid={`skill-delete-${skill.dirName}`}
									className="rounded border border-rose-800 px-2 py-1 text-rose-300"
									onClick={() => setConfirmDelete(skill)}
								>
									Delete
								</button>
							</div>
						</div>
						{selectedId === skill.id && (
							<SkillEditor
								skillId={skill.id}
								onError={fail}
								onChanged={refresh}
								onTested={(conversationId) => navigate(`/c/${conversationId}`)}
							/>
						)}
					</li>
				))}
				{items.length === 0 && (
					<li className="rounded border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">
						No skills yet. <strong>New skill</strong> creates one from a template;{" "}
						<strong>Import</strong> takes a zip, a directory or a pasted SKILL.md.
					</li>
				)}
			</ul>

			{showNew && (
				<NewSkillDialog
					onClose={() => setShowNew(false)}
					onCreated={(created) => {
						setShowNew(false);
						setSelectedId(created.id);
						refresh();
					}}
				/>
			)}
			{showImport && (
				<ImportSkillDialog
					onClose={() => setShowImport(false)}
					onImported={(created) => {
						setShowImport(false);
						setSelectedId(created.id);
						refresh();
					}}
				/>
			)}
			{confirmDelete && (
				<DeleteSkillDialog
					skill={confirmDelete}
					busy={remove.isPending}
					onCancel={() => setConfirmDelete(null)}
					onConfirm={() => remove.mutate(confirmDelete.id)}
				/>
			)}
		</div>
	);
}

// --------------------------------------------------------------------- editor

function SkillEditor({
	skillId,
	onError,
	onChanged,
	onTested,
}: {
	skillId: string;
	onError(error: unknown): void;
	onChanged(): void;
	onTested(conversationId: string): void;
}): JSX.Element {
	const detail = useQuery({ queryKey: ["skill", skillId], queryFn: () => api.skill(skillId) });
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	const [raw, setRaw] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState("SKILL.md");
	const [fileContent, setFileContent] = useState("");
	const [newFile, setNewFile] = useState("");
	const [saved, setSaved] = useState<string | null>(null);
	// A refused save must be visible *at the Save button*: the page-level banner is above the
	// fold once the editor is open (found in the browser).
	const [saveError, setSaveError] = useState<string | null>(null);
	const failHere = (err: unknown): void => {
		setSaveError((err as ApiClientError).message);
		onError(err);
	};

	const data: SkillDetail | undefined = detail.data;
	useEffect(() => {
		if (!data) return;
		setName(data.skillMd.name);
		setDescription(data.skillMd.description);
		setBody(data.skillMd.body);
		setSelectedFile("SKILL.md");
		setRaw(null);
	}, [data]);

	const fileQuery = useQuery({
		queryKey: ["skill-file", skillId, selectedFile],
		queryFn: () => api.skillFile(skillId, selectedFile),
		enabled: selectedFile !== "SKILL.md",
	});
	useEffect(() => {
		if (fileQuery.data) setFileContent(fileQuery.data.content);
	}, [fileQuery.data]);

	const save = useMutation({
		mutationFn: () =>
			raw === null
				? api.patchSkill(skillId, { name, description, body })
				: api.patchSkill(skillId, { raw }),
		onMutate: () => {
			setSaved(null);
			setSaveError(null);
		},
		onSuccess: () => {
			setSaved("Saved.");
			onChanged();
			void detail.refetch();
		},
		onError: failHere,
	});
	const saveFile = useMutation({
		mutationFn: (input: { path: string; content: string }) =>
			api.putSkillFile(skillId, input.path, input.content),
		onMutate: () => setSaveError(null),
		onSuccess: () => {
			setSaved("Saved.");
			onChanged();
			void detail.refetch();
		},
		onError: failHere,
	});
	const removeFile = useMutation({
		mutationFn: (path: string) => api.deleteSkillFile(skillId, path),
		onSuccess: () => {
			setSelectedFile("SKILL.md");
			onChanged();
			void detail.refetch();
		},
		onError: onError,
	});
	const test = useMutation({
		mutationFn: () => api.testSkill(skillId, {}),
		onSuccess: (result) => onTested(result.conversationId),
		onError: onError,
	});

	if (!data) return <p className="p-3 text-xs text-slate-500">Loading…</p>;
	const readOnly = !data.editable;
	const validation = data.validation;

	return (
		<div className="mt-3 grid grid-cols-[180px_1fr] gap-3 border-t border-slate-800 pt-3">
			<div className="space-y-1 text-xs" data-testid="skill-file-tree">
				{data.files.map((file) => (
					<div key={file.path} className="flex items-center justify-between gap-1">
						<button
							type="button"
							data-testid={`skill-file-${file.path}`}
							className={`truncate text-left ${selectedFile === file.path ? "text-sky-300" : "text-slate-300"}`}
							onClick={() => setSelectedFile(file.path)}
						>
							{file.path}
						</button>
						{file.path !== "SKILL.md" && !readOnly && (
							<button
								type="button"
								data-testid={`skill-file-delete-${file.path}`}
								className="text-rose-400"
								onClick={() => removeFile.mutate(file.path)}
							>
								✕
							</button>
						)}
					</div>
				))}
				{!readOnly && (
					<div className="flex gap-1 pt-2">
						<input
							data-testid="skill-new-file-path"
							className="w-full rounded border border-slate-800 bg-slate-950 px-1 py-0.5"
							placeholder="references/api.md"
							value={newFile}
							onChange={(event) => setNewFile(event.target.value)}
						/>
						<button
							type="button"
							data-testid="skill-add-file"
							className="rounded bg-slate-700 px-2"
							onClick={() => {
								if (newFile.trim().length === 0) return;
								saveFile.mutate(
									{ path: newFile.trim(), content: `# ${newFile.trim()}\n` },
									{
										onSuccess: () => {
											setSelectedFile(newFile.trim());
											setNewFile("");
										},
									},
								);
							}}
						>
							+
						</button>
					</div>
				)}
			</div>

			<div className="space-y-2">
				{readOnly && (
					<p className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] text-slate-400">
						This skill is external: piui never edits files it does not own. Unregister it to remove
						it from the catalog.
					</p>
				)}
				{selectedFile === "SKILL.md" ? (
					<>
						{raw === null ? (
							<>
								<label className="block text-xs text-slate-400">
									name
									<input
										data-testid="skill-name"
										className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-sm"
										value={name}
										readOnly={readOnly}
										onChange={(event) => setName(event.target.value)}
									/>
								</label>
								<label className="block text-xs text-slate-400">
									description — the model reads this to decide when to use the skill
									<textarea
										data-testid="skill-description"
										className="mt-1 h-16 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-sm"
										value={description}
										readOnly={readOnly}
										onChange={(event) => setDescription(event.target.value)}
									/>
								</label>
								<CodeEditor
									testId="skill-body"
									value={body}
									readOnly={readOnly}
									onChange={setBody}
									ariaLabel="skill body"
								/>
							</>
						) : (
							<CodeEditor
								testId="skill-raw"
								value={raw}
								readOnly={readOnly}
								onChange={setRaw}
								ariaLabel="raw SKILL.md"
							/>
						)}
						<button
							type="button"
							data-testid="skill-raw-toggle"
							className="text-[11px] text-slate-400 underline"
							onClick={() => setRaw(raw === null ? data.skillMd.raw : null)}
						>
							{raw === null ? "raw mode" : "form mode"}
						</button>
					</>
				) : (
					<CodeEditor
						testId="skill-file-body"
						value={fileContent}
						readOnly={readOnly}
						onChange={setFileContent}
						ariaLabel={selectedFile}
					/>
				)}

				<ValidationPanel validation={validation} />
				{saveError && (
					<p data-testid="skill-save-error" className="text-xs text-rose-300">
						Not saved: {saveError}
					</p>
				)}

				<div className="flex items-center gap-2 text-xs">
					<button
						type="button"
						data-testid="skill-save"
						className="rounded bg-sky-700 px-2 py-1 disabled:opacity-40"
						disabled={readOnly || save.isPending || saveFile.isPending}
						onClick={() =>
							selectedFile === "SKILL.md"
								? save.mutate()
								: saveFile.mutate({ path: selectedFile, content: fileContent })
						}
					>
						Save
					</button>
					<button
						type="button"
						data-testid="skill-save-test"
						className="rounded bg-slate-700 px-2 py-1 disabled:opacity-40"
						disabled={test.isPending}
						onClick={() => {
							if (readOnly || selectedFile !== "SKILL.md") {
								test.mutate();
								return;
							}
							save.mutate(undefined, { onSuccess: () => test.mutate() });
						}}
					>
						Save &amp; test
					</button>
					{saved && <span className="text-slate-500">{saved}</span>}
				</div>
			</div>
		</div>
	);
}

function ValidationPanel({ validation }: { validation: SkillDetail["validation"] }): JSX.Element {
	return (
		<div data-testid="skill-validation" className="rounded border border-slate-800 p-2 text-xs">
			{validation.errors.length === 0 && validation.warnings.length === 0 && (
				<p className="text-emerald-400">No problems found.</p>
			)}
			{validation.errors.map((issue) => (
				<p key={issue.code} className="text-rose-300">
					⚠ {issue.message}
				</p>
			))}
			{validation.warnings.map((issue) => (
				<p key={issue.code} className="text-amber-300">
					• {issue.message}
				</p>
			))}
		</div>
	);
}

// --------------------------------------------------------------------- dialogs

function Dialog({
	title,
	children,
	onClose,
	testId,
}: {
	title: string;
	children: React.ReactNode;
	onClose(): void;
	testId: string;
}): JSX.Element {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
			<div
				data-testid={testId}
				className="w-full max-w-lg space-y-3 rounded border border-slate-700 bg-slate-900 p-4 text-sm"
			>
				<div className="flex items-center justify-between">
					<h2 className="font-semibold">{title}</h2>
					<button type="button" className="text-slate-400" onClick={onClose}>
						✕
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

function NewSkillDialog({
	onClose,
	onCreated,
}: {
	onClose(): void;
	onCreated(skill: SkillSummary): void;
}): JSX.Element {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [template, setTemplate] = useState<SkillTemplate>("basic");
	const [error, setError] = useState<string | null>(null);
	const create = useMutation({
		mutationFn: () => api.createSkill({ name, description, template }),
		onMutate: () => setError(null),
		onSuccess: onCreated,
		onError: (err) => setError((err as ApiClientError).message),
	});

	return (
		<Dialog title="New skill" onClose={onClose} testId="skill-new-dialog">
			<label className="block text-xs text-slate-400">
				name
				<input
					data-testid="new-skill-name"
					className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</label>
			<label className="block text-xs text-slate-400">
				description
				<textarea
					data-testid="new-skill-description"
					className="mt-1 h-16 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1"
					value={description}
					onChange={(event) => setDescription(event.target.value)}
				/>
			</label>
			<div className="flex gap-2 text-xs">
				{TEMPLATES.map((option) => (
					<button
						key={option.id}
						type="button"
						data-testid={`new-skill-template-${option.id}`}
						className={`rounded border px-2 py-1 ${template === option.id ? "border-sky-600 text-sky-300" : "border-slate-700 text-slate-400"}`}
						onClick={() => setTemplate(option.id)}
					>
						{option.label}
						<span className="ml-1 text-[10px] text-slate-500">{option.hint}</span>
					</button>
				))}
			</div>
			{error && (
				<p data-testid="new-skill-error" className="text-xs text-rose-400">
					{error}
				</p>
			)}
			<button
				type="button"
				data-testid="new-skill-create"
				className="rounded bg-sky-700 px-2 py-1 text-xs"
				disabled={create.isPending}
				onClick={() => create.mutate()}
			>
				Create
			</button>
		</Dialog>
	);
}

function ImportSkillDialog({
	onClose,
	onImported,
}: {
	onClose(): void;
	onImported(skill: SkillSummary): void;
}): JSX.Element {
	const [path, setPath] = useState("");
	const [skillMd, setSkillMd] = useState("");
	const [error, setError] = useState<string | null>(null);
	const fail = (err: unknown): void => setError((err as ApiClientError).message);

	const importPath = useMutation({
		mutationFn: () => api.importSkill({ path }),
		onMutate: () => setError(null),
		onSuccess: onImported,
		onError: fail,
	});
	const importPaste = useMutation({
		mutationFn: () => api.importSkill({ skillMd }),
		onMutate: () => setError(null),
		onSuccess: onImported,
		onError: fail,
	});
	const importZip = useMutation({
		mutationFn: (file: File) => api.importSkillZip(file),
		onMutate: () => setError(null),
		onSuccess: onImported,
		onError: fail,
	});

	return (
		<Dialog title="Import a skill" onClose={onClose} testId="skill-import-dialog">
			<div className="space-y-1">
				<p className="text-xs text-slate-400">Upload a .zip</p>
				<input
					type="file"
					accept=".zip,application/zip"
					data-testid="import-zip"
					className="text-xs"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) importZip.mutate(file);
					}}
				/>
			</div>
			<div className="space-y-1">
				<p className="text-xs text-slate-400">…or register an existing directory</p>
				<div className="flex gap-2">
					<input
						data-testid="import-path"
						className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs"
						placeholder="/home/me/.claude/skills/pdf-tools"
						value={path}
						onChange={(event) => setPath(event.target.value)}
					/>
					<button
						type="button"
						data-testid="import-path-submit"
						className="rounded bg-slate-700 px-2 text-xs"
						onClick={() => importPath.mutate()}
					>
						Register
					</button>
				</div>
			</div>
			<div className="space-y-1">
				<p className="text-xs text-slate-400">…or paste a SKILL.md</p>
				<textarea
					data-testid="import-skillmd"
					className="h-24 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px]"
					value={skillMd}
					onChange={(event) => setSkillMd(event.target.value)}
				/>
				<button
					type="button"
					data-testid="import-skillmd-submit"
					className="rounded bg-slate-700 px-2 py-1 text-xs"
					onClick={() => importPaste.mutate()}
				>
					Import
				</button>
			</div>
			{error && (
				<p data-testid="import-error" className="text-xs text-rose-400">
					{error}
				</p>
			)}
		</Dialog>
	);
}

function DeleteSkillDialog({
	skill,
	busy,
	onCancel,
	onConfirm,
}: {
	skill: SkillSummary;
	busy: boolean;
	onCancel(): void;
	onConfirm(): void;
}): JSX.Element {
	// §A.5: the dialog must name the profiles that lose the skill, so ask the server first.
	const detail = useQuery({ queryKey: ["skill", skill.id], queryFn: () => api.skill(skill.id) });
	const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
	const affected = (profiles.data?.items ?? []).filter((profile) =>
		profile.skillIds.includes(skill.id),
	);

	return (
		<Dialog title={`Delete "${skill.name}"?`} onClose={onCancel} testId="skill-delete-dialog">
			<p className="text-xs text-slate-300">
				{skill.source === "managed"
					? `The directory moves to $PIUI_HOME/trash/skills/ (${detail.data?.files.length ?? 0} files). It is not deleted from disk.`
					: "The registration is removed. piui never touches the files of an external skill."}
			</p>
			{affected.length > 0 && (
				<p data-testid="skill-delete-affected" className="text-xs text-amber-300">
					These profiles lose the skill: {affected.map((profile) => profile.name).join(", ")}.
				</p>
			)}
			<div className="flex justify-end gap-2 text-xs">
				<button type="button" className="rounded bg-slate-700 px-2 py-1" onClick={onCancel}>
					Cancel
				</button>
				<button
					type="button"
					data-testid="skill-delete-confirm"
					className="rounded bg-rose-700 px-2 py-1"
					disabled={busy}
					onClick={onConfirm}
				>
					Delete
				</button>
			</div>
		</Dialog>
	);
}
