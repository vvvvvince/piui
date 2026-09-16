// Global tool enable/disable + "used by N profiles". spec/05-skills-and-tools.md §B.2.
// All SQL against `tool_settings` / `profile_tools` lives here (spec/01-architecture.md §2.2).
import { Repository } from "./base.js";

export class ToolSettingsRepository extends Repository {
	/** Only names explicitly disabled; anything absent is enabled. */
	disabledNames(): Set<string> {
		const rows = this.db.prepare("SELECT name FROM tool_settings WHERE enabled = 0").all() as {
			name: string;
		}[];
		return new Set(rows.map((row) => row.name));
	}

	setEnabled(name: string, enabled: boolean): void {
		const now = this.clock.nowIso();
		this.db
			.prepare(
				`INSERT INTO tool_settings (name, enabled, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
			)
			.run(name, enabled ? 1 : 0, now);
	}

	/** tool name → number of profiles that selected it. */
	profileUsage(): Map<string, number> {
		const rows = this.db
			.prepare("SELECT tool_name, COUNT(*) AS uses FROM profile_tools GROUP BY tool_name")
			.all() as { tool_name: string; uses: number }[];
		return new Map(rows.map((row) => [row.tool_name, row.uses]));
	}
}
