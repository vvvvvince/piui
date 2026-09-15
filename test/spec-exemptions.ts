// Acceptance criteria that are deliberately not automated, and criteria not yet due.
// spec/20-development-method.md §2 — every entry needs a one-line reason; this list is
// reviewed at every milestone gate.

/** Milestones whose acceptance lists are enforced by test/spec-coverage.test.ts. */
export const COMPLETED_MILESTONES = ["M0", "M1"] as const;

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
	// 14-credentials is an M1+M2 spec: only the step-up item (9.7) is due at M1.
	"14-credentials#9.1": "M2",
	"14-credentials#9.2": "M2",
	"14-credentials#9.3": "M2",
	"14-credentials#9.4": "M2",
	"14-credentials#9.5": "M2",
	"14-credentials#9.6": "M2",
	"14-credentials#9.8": "M2",
	"14-credentials#9.9": "M2",
	"14-credentials#9.10": "M2",
	"19-deployment#9.3": "M2",
	"19-deployment#9.4": "M7",
	"19-deployment#9.5": "M4",
	"19-deployment#9.6": "M7",
	"19-deployment#9.7": "M7",
	"19-deployment#9.10": "M3",
	"19-deployment#9.11": "M7",
};
