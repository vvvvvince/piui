// The only place that asks pi which built-in tools it actually ships.
// spec/05-skills-and-tools.md §B.1: "the registry MUST validate these names against the
// installed pi version at boot and log an error if a name disappeared upstream".
import { tmpdir } from "node:os";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";

/** Names pi 0.85.1 produces for its built-in tools. */
export function installedBuiltinToolNames(): string[] {
	const cwd = tmpdir();
	const factories = [
		createReadTool,
		createLsTool,
		createGrepTool,
		createFindTool,
		createEditTool,
		createWriteTool,
		createBashTool,
		createPowerShellTool,
	];
	const names: string[] = [];
	for (const factory of factories) {
		try {
			const tool = (factory as (cwd: string) => { name?: string })(cwd);
			if (tool?.name) names.push(tool.name);
		} catch {
			// a factory that no longer exists/works simply contributes no name
		}
	}
	return names;
}
