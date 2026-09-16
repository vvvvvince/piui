// Acceptance criteria that are deliberately not automated, and criteria not yet due.
// spec/20-development-method.md §2 — every entry needs a one-line reason; this list is
// reviewed at every milestone gate.

/** Milestones whose acceptance lists are enforced by test/spec-coverage.test.ts. */
export const COMPLETED_MILESTONES = ["M0", "M1", "M2"] as const;

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
	// 07-chat-mode: web search is M3, image attachments may slip to M6 (plan/03 §8).
	"07-chat-mode#6.2": "M3",
	"07-chat-mode#6.3": "M3",
	"07-chat-mode#6.4": "M6",
	// 15-commands-and-input is an M2+M5b spec: M2 ships §4's input semantics (tagged in
	// client/src/components/Composer.test.tsx), the `/` menu and prompt templates are M5b.
	"15-commands-and-input#6.1": "M5b",
	"15-commands-and-input#6.2": "M5b",
	"15-commands-and-input#6.3": "M5b",
	"15-commands-and-input#6.4": "M5b",
	"15-commands-and-input#6.5": "M5b",
	"15-commands-and-input#6.6": "M5b",
	"15-commands-and-input#6.7": "M5b",
	"15-commands-and-input#6.8": "M5b",
	"15-commands-and-input#6.9": "M5b",
	"15-commands-and-input#6.10": "M5b",
	// 14-credentials §§9.1-9.6, 9.8-9.10 landed in M2; 9.7 in M1.
	"19-deployment#9.4": "M7",
	"19-deployment#9.5": "M4",
	"19-deployment#9.6": "M7",
	"19-deployment#9.7": "M7",
	"19-deployment#9.10": "M3",
	"19-deployment#9.11": "M7",
};
