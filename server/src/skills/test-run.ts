// The skill test run. spec/05-skills-and-tools.md §A.4, spec/09-api.md §6.
//
// An ephemeral conversation: only this skill, `tools: ["read"]` (+ `bash` on request), an empty
// scratch cwd and the auto prompt `/skill:<name>`. It is flagged `ephemeral = 1` rather than kept
// in a table of its own, so the whole transcript/SSE/abort machinery applies unchanged; the list
// route filters it out and the sweep below deletes it an hour later.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Principal, SkillTestRequest, SkillTestResponse } from "@piui/shared";
import type { AppContext } from "../context.js";
import { ApiError } from "../http/errors.js";
import type { Services } from "../services.js";

export const EPHEMERAL_TTL_MS = 60 * 60 * 1000;

export class SkillTestRunner {
	constructor(
		private readonly ctx: AppContext,
		private readonly services: () => Services,
	) {}

	async start(
		principal: Principal,
		skillId: string,
		body: SkillTestRequest,
	): Promise<SkillTestResponse> {
		this.sweep();
		const services = this.services();
		const row = this.ctx.repos.skills.get(principal, skillId);
		if (!row) throw new ApiError("not_found", `No skill ${skillId}.`);
		const model = await this.pickModel(principal, body);
		const tools = body.allowBash ? ["read", "bash"] : ["read"];

		const conversation = this.ctx.repos.conversations.create(principal, {
			mode: "agent",
			provider: model.provider,
			modelId: model.modelId,
			title: `Test: ${row.name}`,
			ephemeral: true,
			skillId: row.id,
		});
		this.ctx.repos.conversations.setEphemeralTools(conversation.id, tools);
		// pi expands `/skill:<name>` itself (spike plan/spikes/10 §2, plan/spikes/12 §3).
		await services.conversations.prompt(principal, conversation.id, `/skill:${row.name}`);
		return { conversationId: conversation.id, ephemeral: true };
	}

	/** §A.4 — "deleted after 1 h". Runs on boot next to M2's scratch sweep and on every start. */
	sweep(): void {
		const cutoff = new Date(this.ctx.clock.nowMs() - EPHEMERAL_TTL_MS).toISOString();
		for (const row of this.ctx.repos.conversations.expiredEphemeral(cutoff)) {
			this.services().hub.forget(row.id);
			this.ctx.repos.conversations.deleteById(row.id);
			if (row.session_path) rmSync(row.session_path, { force: true });
			rmSync(join(this.ctx.config.paths.scratch, row.id), { recursive: true, force: true });
		}
	}

	/** The request's model, else the most recent conversation's, else the first available one. */
	private async pickModel(
		principal: Principal,
		body: SkillTestRequest,
	): Promise<{ provider: string; modelId: string }> {
		const services = this.services();
		if (body.provider && body.modelId) {
			if (!services.models.getModel(body.provider, body.modelId)) {
				throw new ApiError("model_unavailable", `No model ${body.provider}/${body.modelId}.`);
			}
			return { provider: body.provider, modelId: body.modelId };
		}
		const recent = this.ctx.repos.conversations.list(principal, { limit: 1 })[0];
		if (recent) return { provider: recent.provider, modelId: recent.model_id };
		const first = (await services.models.list()).items.find((model) => model.available);
		if (!first) {
			throw new ApiError(
				"model_unavailable",
				"No model is available yet — add a provider key in Settings first.",
			);
		}
		return { provider: first.provider, modelId: first.id };
	}

	/** The pi session inputs for a test run (read by ConversationService.createPiSession). */
	sessionInputs(skillId: string, toolsJson: string | null): { tools: string[] } {
		void skillId;
		try {
			const parsed = JSON.parse(toolsJson ?? "") as unknown;
			if (Array.isArray(parsed))
				return { tools: parsed.filter((n): n is string => typeof n === "string") };
		} catch {
			/* fall through to the default */
		}
		return { tools: ["read"] };
	}
}
