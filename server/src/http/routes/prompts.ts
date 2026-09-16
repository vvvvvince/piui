// spec/09-api.md §8 / spec/15-commands-and-input.md §5 — the prompt-template surface.
// `POST /api/prompts/rescan` is admin-only through the `*/rescan` matcher in http/authz.ts.
import type { PromptRescanResponse, PromptsResponse } from "@piui/shared";
import type { CommandService } from "../../commands/service.js";
import type { PiuiFastify } from "../auth.js";

export async function registerPromptRoutes(
	app: PiuiFastify,
	commands: CommandService,
): Promise<void> {
	app.get("/api/prompts", async (): Promise<PromptsResponse> => commands.list());

	app.post("/api/prompts/rescan", async (): Promise<PromptRescanResponse> => commands.rescan());
}
