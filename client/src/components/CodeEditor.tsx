// The one code editor in piui (spec/10-frontend.md §2: `SkillEditor … + CodeMirror`).
// Kept deliberately thin: CodeMirror 6 through @uiw/react-codemirror, markdown mode, dark theme.
import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";

export interface CodeEditorProps {
	value: string;
	onChange(value: string): void;
	readOnly?: boolean;
	height?: string;
	testId?: string;
	ariaLabel?: string;
}

export function CodeEditor({
	value,
	onChange,
	readOnly,
	height = "360px",
	testId,
	ariaLabel,
}: CodeEditorProps): JSX.Element {
	return (
		<div
			data-testid={testId}
			className="overflow-hidden rounded border border-slate-800 bg-slate-950 text-sm"
		>
			<CodeMirror
				value={value}
				height={height}
				theme="dark"
				extensions={[markdown()]}
				readOnly={readOnly === true}
				aria-label={ariaLabel ?? "editor"}
				basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: !readOnly }}
				onChange={onChange}
			/>
		</div>
	);
}
