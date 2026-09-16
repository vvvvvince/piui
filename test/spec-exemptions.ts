// Acceptance criteria that are deliberately not automated, and criteria not yet due.
// spec/20-development-method.md §2 — every entry needs a one-line reason; this list is
// reviewed at every milestone gate.

/** Milestones whose acceptance lists are enforced by test/spec-coverage.test.ts. */
export const COMPLETED_MILESTONES = ["M0", "M1", "M2", "M3", "M4", "M5", "M5b"] as const;

/** Permanently exempt: manual, environmental, or process criteria. */
export const exemptions: Record<string, string> = {
	"19-deployment#9.12":
		"multi-arch image build is a CI concern; asserted by the release workflow, not by vitest",
	"20-development-method#9.5":
		"'every merge commit has a green suite' is a branch-protection rule, not a runnable assertion",
	"20-development-method#9.6":
		"mutation spot-check is performed by hand once per milestone and recorded in plan/milestone-notes.md",
};

/**
 * Not yet due: the milestone that will cover each criterion. The coverage test fails if a
 * pending tag belongs to a completed milestone, so this list cannot rot silently.
 */
export const pending: Record<string, string> = {
	// 07-chat-mode: web search landed in M3; image attachments may slip to M6 (plan/03 §8).
	"07-chat-mode#6.4": "M6",
	// 05-skills-and-tools became due with M3 (its B.5.{1,2} are the M3 gate). The rest of part B
	// needs HTTP tools, profiles and the skill CRUD surface, which are M6.
	"05-skills-and-tools#B.5.3": "M6",
	"05-skills-and-tools#B.5.4": "M6",
	"05-skills-and-tools#B.5.5": "M6",
	"05-skills-and-tools#B.5.6": "M6",
	// 14-credentials §§9.1-9.6, 9.8-9.10 landed in M2; 9.7 in M1.
	"19-deployment#9.4": "M7",
	// M4 covers its second half offline (`PIUI_WORKSPACE_ROOTS` refuses a path outside the roots,
	// server/test/integration/workspaces.test.ts). The first half — an *agent* run writing a file
	// that lands on the host as uid 10001 — needs agent mode (M5) and a running container: M7.
	"19-deployment#9.5": "M7",
	"19-deployment#9.6": "M7",
	"19-deployment#9.7": "M7",
	// M3 ships the searxng provider and the compose `search` profile is wired, but "works end to
	// end against the bundled SearXNG" needs the image pulled and running: an M7 container check.
	"19-deployment#9.10": "M7",
	"19-deployment#9.11": "M7",
};
