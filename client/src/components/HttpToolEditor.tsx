// The HTTP-tool editor of spec/05-skills-and-tools.md §B.2: form, parameter schema builder,
// header rows (values write-only — a stored value always reads back as ***), and the Test button.
import type { HttpToolDetail, HttpToolParam, HttpToolParamType } from "@piui/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiClientError, api } from "../api/client.js";

const TYPES: HttpToolParamType[] = ["string", "number", "boolean", "string[]"];

export interface HttpToolEditorProps {
	/** Undefined for "New HTTP tool". */
	tool?: HttpToolDetail;
	onSaved(): void;
	onCancel(): void;
}

export function HttpToolEditor({ tool, onSaved, onCancel }: HttpToolEditorProps): JSX.Element {
	const [name, setName] = useState(tool?.name ?? "");
	const [label, setLabel] = useState(tool?.label ?? "");
	const [description, setDescription] = useState(tool?.description ?? "");
	const [method, setMethod] = useState<"GET" | "POST">(tool?.method ?? "GET");
	const [urlTemplate, setUrlTemplate] = useState(tool?.urlTemplate ?? "https://");
	const [bodyTemplate, setBodyTemplate] = useState(tool?.bodyTemplate ?? "");
	const [timeoutMs, setTimeoutMs] = useState(tool?.timeoutMs ?? 20000);
	const [params, setParams] = useState<HttpToolParam[]>(tool?.parameters ?? []);
	const [headers, setHeaders] = useState<{ key: string; value: string }[]>(
		Object.entries(tool?.headers ?? {}).map(([key, value]) => ({ key, value })),
	);
	const [testParams, setTestParams] = useState("{}");
	const [error, setError] = useState<string | null>(null);

	const body = (): Record<string, unknown> => ({
		name,
		label: label || name,
		description,
		method,
		urlTemplate,
		headers: Object.fromEntries(
			headers.filter((row) => row.key.trim().length > 0).map((row) => [row.key.trim(), row.value]),
		),
		bodyTemplate: method === "POST" ? bodyTemplate || null : null,
		parameters: params,
		timeoutMs,
	});

	const save = useMutation({
		mutationFn: () =>
			tool
				? api.patchHttpTool(tool.id, body())
				: api.createHttpTool(body() as unknown as Parameters<typeof api.createHttpTool>[0]),
		onMutate: () => setError(null),
		onSuccess: onSaved,
		onError: (err) => setError((err as ApiClientError).message),
	});
	const test = useMutation({
		mutationFn: () =>
			api.testHttpTool(tool!.id, JSON.parse(testParams || "{}") as Record<string, unknown>),
		onMutate: () => setError(null),
		onError: (err) => setError((err as ApiClientError).message),
	});

	return (
		<div
			data-testid="http-tool-editor"
			className="space-y-2 rounded border border-slate-700 bg-slate-900/60 p-3 text-sm"
		>
			<div className="grid grid-cols-2 gap-2">
				<label className="text-xs text-slate-400">
					name (lowercase, 3–48)
					<input
						data-testid="http-tool-name"
						className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-sm"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label className="text-xs text-slate-400">
					label
					<input
						data-testid="http-tool-label"
						className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-sm"
						value={label}
						onChange={(event) => setLabel(event.target.value)}
					/>
				</label>
			</div>
			<label className="block text-xs text-slate-400">
				description — write it for the model: what it does and when to use it
				<textarea
					data-testid="http-tool-description"
					className="mt-1 h-16 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-sm"
					value={description}
					onChange={(event) => setDescription(event.target.value)}
				/>
			</label>
			<div className="flex gap-2">
				<select
					data-testid="http-tool-method"
					className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-sm"
					value={method}
					onChange={(event) => setMethod(event.target.value as "GET" | "POST")}
				>
					<option value="GET">GET</option>
					<option value="POST">POST</option>
				</select>
				<input
					data-testid="http-tool-url"
					className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs"
					value={urlTemplate}
					placeholder="https://api.example.com/x?q={query}"
					onChange={(event) => setUrlTemplate(event.target.value)}
				/>
			</div>
			{method === "POST" && (
				<label className="block text-xs text-slate-400">
					body template (JSON, {"{param}"} substituted)
					<textarea
						data-testid="http-tool-body"
						className="mt-1 h-16 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs"
						value={bodyTemplate}
						onChange={(event) => setBodyTemplate(event.target.value)}
					/>
				</label>
			)}

			<fieldset className="rounded border border-slate-800 p-2">
				<legend className="px-1 text-xs text-slate-400">parameters</legend>
				{params.map((param, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: row identity is its position; a value-derived key remounts the input on each keystroke
					<div key={`param-${index}`} className="mb-1 flex items-center gap-1 text-xs">
						<input
							data-testid={`http-param-name-${index}`}
							className="w-32 rounded border border-slate-800 bg-slate-950 px-1 py-0.5 font-mono"
							value={param.name}
							onChange={(event) =>
								setParams(
									params.map((p, i) => (i === index ? { ...p, name: event.target.value } : p)),
								)
							}
						/>
						<select
							data-testid={`http-param-type-${index}`}
							className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5"
							value={param.type}
							onChange={(event) =>
								setParams(
									params.map((p, i) =>
										i === index ? { ...p, type: event.target.value as HttpToolParamType } : p,
									),
								)
							}
						>
							{TYPES.map((type) => (
								<option key={type} value={type}>
									{type}
								</option>
							))}
						</select>
						<label className="flex items-center gap-1">
							<input
								type="checkbox"
								data-testid={`http-param-required-${index}`}
								checked={param.required}
								onChange={(event) =>
									setParams(
										params.map((p, i) =>
											i === index ? { ...p, required: event.target.checked } : p,
										),
									)
								}
							/>
							required
						</label>
						<input
							data-testid={`http-param-description-${index}`}
							className="flex-1 rounded border border-slate-800 bg-slate-950 px-1 py-0.5"
							placeholder="what the model should pass"
							value={param.description ?? ""}
							onChange={(event) =>
								setParams(
									params.map((p, i) =>
										i === index ? { ...p, description: event.target.value } : p,
									),
								)
							}
						/>
						<button
							type="button"
							className="text-rose-400"
							onClick={() => setParams(params.filter((_, i) => i !== index))}
						>
							✕
						</button>
					</div>
				))}
				<button
					type="button"
					data-testid="http-param-add"
					className="rounded bg-slate-700 px-2 py-0.5 text-xs"
					onClick={() => setParams([...params, { name: "", type: "string", required: false }])}
				>
					Add parameter
				</button>
			</fieldset>

			<fieldset className="rounded border border-slate-800 p-2">
				<legend className="px-1 text-xs text-slate-400">
					headers — use <code className="font-mono">{"$" + "{ENV_VAR}"}</code>; values are stored
					server-side and never shown again
				</legend>
				{headers.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: see the parameter rows above.
					<div key={`header-${index}`} className="mb-1 flex gap-1 text-xs">
						<input
							data-testid={`http-header-key-${index}`}
							className="w-40 rounded border border-slate-800 bg-slate-950 px-1 py-0.5 font-mono"
							value={row.key}
							onChange={(event) =>
								setHeaders(
									headers.map((h, i) => (i === index ? { ...h, key: event.target.value } : h)),
								)
							}
						/>
						<input
							data-testid={`http-header-value-${index}`}
							className="flex-1 rounded border border-slate-800 bg-slate-950 px-1 py-0.5 font-mono"
							value={row.value}
							onChange={(event) =>
								setHeaders(
									headers.map((h, i) => (i === index ? { ...h, value: event.target.value } : h)),
								)
							}
						/>
						<button
							type="button"
							className="text-rose-400"
							onClick={() => setHeaders(headers.filter((_, i) => i !== index))}
						>
							✕
						</button>
					</div>
				))}
				<button
					type="button"
					data-testid="http-header-add"
					className="rounded bg-slate-700 px-2 py-0.5 text-xs"
					onClick={() => setHeaders([...headers, { key: "", value: "" }])}
				>
					Add header
				</button>
			</fieldset>

			<label className="block text-xs text-slate-400">
				timeout (ms, 1000–60000)
				<input
					data-testid="http-tool-timeout"
					type="number"
					className="mt-1 w-32 rounded border border-slate-800 bg-slate-950 px-2 py-1 text-sm"
					value={timeoutMs}
					onChange={(event) => setTimeoutMs(Number(event.target.value))}
				/>
			</label>

			{error && (
				<p data-testid="http-tool-error" className="text-xs text-rose-400">
					{error}
				</p>
			)}

			<div className="flex items-center gap-2 text-xs">
				<button
					type="button"
					data-testid="http-tool-save"
					className="rounded bg-sky-700 px-2 py-1"
					disabled={save.isPending}
					onClick={() => save.mutate()}
				>
					Save
				</button>
				<button type="button" className="rounded bg-slate-700 px-2 py-1" onClick={onCancel}>
					Cancel
				</button>
				{tool && (
					<>
						<input
							data-testid="http-tool-test-params"
							className="w-52 rounded border border-slate-800 bg-slate-950 px-1 py-0.5 font-mono"
							value={testParams}
							onChange={(event) => setTestParams(event.target.value)}
						/>
						<button
							type="button"
							data-testid="http-tool-test"
							className="rounded bg-slate-700 px-2 py-1"
							disabled={test.isPending}
							onClick={() => test.mutate()}
						>
							Test
						</button>
					</>
				)}
			</div>
			{test.data && (
				<pre
					data-testid="http-tool-test-result"
					className="max-h-48 overflow-auto rounded bg-slate-950 p-2 font-mono text-[11px] text-slate-300"
				>
					{test.data.status} · {test.data.durationMs} ms{"\n"}
					{test.data.body}
				</pre>
			)}
		</div>
	);
}
