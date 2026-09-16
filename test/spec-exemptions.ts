// Acceptance criteria that are deliberately not automated, and criteria not yet due.
// spec/20-development-method.md §2 — every entry needs a one-line reason; this list is
// reviewed at every milestone gate.

/** Milestones whose acceptance lists are enforced by test/spec-coverage.test.ts. */
export const COMPLETED_MILESTONES = [
	"M0",
	"M1",
	"M2",
	"M3",
	"M4",
	"M5",
	"M5b",
	"M5c",
	"M6",
	"M7",
] as const;

/** Permanently exempt: manual, environmental, or process criteria. */
export const exemptions: Record<string, string> = {
	"19-deployment#9.12":
		"multi-arch image build is a CI concern; asserted by the release workflow, not by vitest",
	"20-development-method#9.5":
		"'every merge commit has a green suite' is a branch-protection rule, not a runnable assertion",
	"20-development-method#9.6":
		"mutation spot-check is performed by hand once per milestone and recorded in plan/milestone-notes.md",
	// M7: the remaining container criteria need a running Docker daemon and, for 9.10, the real
	// network. They are executed by hand at the milestone gate and recorded in
	// plan/milestone-notes.md §M7 ("verified by hand"), with the exact commands.
	"19-deployment#9.5":
		"needs a running container + bind mount: the host-side uid 10001 ownership cannot be asserted offline",
	"19-deployment#9.6":
		"'docker compose restart/down -v' semantics are a Docker behaviour, verified by hand at the gate",
	"19-deployment#9.7":
		"graceful shutdown on `docker stop` is observed in container logs at the gate; vitest has no PID 1",
	"19-deployment#9.10":
		"end-to-end SearXNG needs the image pulled and real network; the wiring and settings file are asserted offline",
	"19-deployment#9.11":
		"building a derived image from the documented example needs a Docker daemon; run by hand at the gate",
	// spec/10-frontend.md §4's UX states are design criteria: the ones with observable markup are
	// covered by component tests ([10-frontend#4.x] in UxStates.test.tsx / Routes.test.tsx), the
	// rest (visual design of skeletons, pulse, focus rings) are a manual pass recorded in the
	// milestone notes.
};

/**
 * Not yet due: the milestone that will cover each criterion. The coverage test fails if a
 * pending tag belongs to a completed milestone, so this list cannot rot silently.
 */
export const pending: Record<string, string> = {
	// Everything M0-M7 is either tested or exempted above; nothing is parked for a later
	// milestone in V1. Items deferred beyond V1 are marked `[LATER]` in the spec itself and
	// therefore produce no acceptance criteria.
};
