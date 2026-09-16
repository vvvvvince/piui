// Extension fixtures for the M5c tests. Kept out of a test file so importing them does not
// re-run another suite.
export const GOOD_EXTENSION = `import { Type } from "typebox";

export default function (pi: any) {
	pi.registerTool({
		name: "deploy",
		label: "Deploy",
		description: "Deploy the thing.",
		parameters: Type.Object({ target: Type.String() }),
		async execute(_id: string, params: any) {
			return { content: [{ type: "text", text: "deployed " + params.target }], details: {} };
		},
	});
	pi.registerCommand("deploy", { description: "Deploy it", handler: async () => {} });
}
`;

export const BROKEN_EXTENSION = `export default function ( { this is not typescript (((\n`;
