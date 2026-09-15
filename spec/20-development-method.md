---
id: 20-development-method
title: Development method — test-driven development
status: normative
read_first: true
summary: >-
  TDD is the mandated development method. Defines the red-green-refactor loop, the
  acceptance-criterion-to-test mapping that makes the spec executable, the test seams that must
  exist before feature work (scripted fake model provider, injectable clock, temp PIUI_HOME,
  principal injection, SSE harness), the mocking policy, what is exempt, and the CI gates.
covers: [tdd, testing, test-seams, fake-model, ci, definition-of-done, mocking-policy]
depends_on: [12-milestones]
required_by: [12-milestones]
decisions: [R1]
milestones: [M0]
spec_version: 1
updated: 2026-02-20
---

# 20 — Development method: test-driven development

> **Requirement R1**: piui is built test-first. No production code is written without a failing
> test that demands it. This document is normative and applies to every milestone in
> `12-milestones.md`.

## 1. The loop

1. **Red** — write the smallest failing test that expresses the next required behavior. Run it.
   It must fail *for the intended reason* (assertion, not a missing import or a typo).
2. **Green** — write the minimum code to pass. Duplication and ugliness are allowed here.
3. **Refactor** — clean up with the suite green. No behavior change, no new tests.
4. Commit at green. A commit that leaves the suite red is a defect, not a checkpoint.

Rules of engagement:

- **No production code without a failing test.** The one exception is the *walking skeleton* in
  M0 (wiring a framework together so that a test can exist at all) — and even there, the
  skeleton's first job is to make `GET /api/health` testable.
- **One behavior per test.** A test name states the behavior, not the implementation:
  `rejects a workspace path on the denylist`, not `test validatePath 3`.
- **Test through the public seam**, not internals: HTTP routes via `fastify.inject()`, domain
  logic via its module API, React via user-visible behavior (`@testing-library/react`). Private
  functions are tested through their callers unless they contain genuinely tricky logic
  (parsers, path validation, template composition) — those get direct unit tests.
- **Bug fixes start with a failing regression test** that reproduces the report, referencing the
  issue in the test name.
- Refactoring never happens on red; if a refactor breaks tests, revert rather than "fix
  forward".

## 2. The spec is the test backlog

Every acceptance criterion in every spec file is already written as an assertion. They are the
**executable contract**, so they map 1:1 to tests:

- Each test that covers an acceptance criterion carries a tag in its name:
  `[03-profiles#8.2]`, `[19-deployment#9.7]`, etc. — `<spec id>#<section>.<item>`.
- A **coverage-of-spec** test (`test/spec-coverage.test.ts`) parses the acceptance sections of
  `spec/*.md`, collects every numbered item, and fails if any item has no test carrying its tag.
  Items deliberately not automated (manual UX passes, multi-arch CI builds) must be listed in
  `test/spec-exemptions.ts` **with a one-line reason** — an explicit, reviewable list, not
  silence.
- This is the metric that matters. There is **no line-coverage target**: a percentage would
  reward testing getters. "Every acceptance criterion has a named test or a justified
  exemption" is the gate.

Working a milestone therefore means: read its acceptance list → write those tests red → make
them green one at a time. The lists in `12-milestones.md` are the milestone's todo list.

## 3. Test seams that MUST exist before feature work (M0)

TDD fails in this codebase if these are missing, because the interesting behavior involves an
LLM, a filesystem, a clock and a stream. Build them in M0, test-first themselves.

### 3.1 Scripted fake model provider `[critical]`

Verified feasible against the installed pi: `ModelRuntime.registerProvider(id, config)` accepts
a `ProviderConfigInput` with `streamSimple` and a `models` array, and `pi-ai` exports
`createAssistantMessageEventStream()` (see pi's `docs/custom-provider.md` → *Custom Streaming
API*). So piui can register a provider that replays a scripted script instead of calling a
network.

```ts
// server/test/support/fake-model.ts
type Script = Array<
  | { text: string }                                   // emits text deltas
  | { thinking: string }
  | { toolCall: { name: string; args: unknown } }      // emits a tool call the real tool executes
  | { error: { status: number; message: string } }     // provider error, for retry paths
  | { stall: number }                                  // delay, for abort/timeout paths
>;

registerFakeProvider(runtime, { id: "fake", models: ["fake-1"], scripts: Script[] });
```

Requirements:
- Deltas are emitted in small chunks so streaming, coalescing and SSE ordering are genuinely
  exercised — not one whole message.
- Usage and cost are reported with fixed numbers so cost assertions are deterministic.
- Tool calls go through the **real** tool execution path (real `bash` in a temp dir, real
  `write`), because that path is what breaks.
- A script can be queued per turn, so multi-turn agent loops (tool call → result → final answer)
  are expressible.
- Selected by `PIUI_FAKE_MODEL=1`, never registered in production builds.

This single seam is what makes chat mode, agent mode, steering, abort, compaction, retry and
usage accounting testable offline, deterministically, for free.

### 3.2 Filesystem and database isolation

- Every test gets a fresh `PIUI_HOME` in `os.tmpdir()`, removed in teardown. A helper
  `withTempHome(fn)` provides it; no test touches the developer's real `~/.piui` or `~/.pi`.
- SQLite runs against a file inside that temp home (not `:memory:`, so WAL, migrations and
  foreign keys behave as in production). The migration runner is exercised by every test run,
  which is free migration testing.
- Workspaces used in tests are temp dirs; a `withWorkspace()` helper seeds a small file tree.

### 3.3 Injectable clock and ids

`now()` and `newId()` come from an injected `Clock`/`IdGen` (default: real). Required for
deterministic tests of memory timestamps, session expiry, step-up windows, the 15-minute idle
eviction, `PIUI_MAX_RUN_MINUTES`, and SSE ping intervals. **No `setTimeout`-based sleeping in
tests** — advance the fake clock.

### 3.4 Principal injection

Per `18-multi-user.md`, tests must be able to act as an arbitrary `Principal` (`role: "user"`,
a second user, an inactive user) without a login round trip. A test helper mints a session row
directly and returns its cookie. This is what makes the authorization acceptance criteria
testable in V1 despite there being one real user.

### 3.5 SSE harness

A helper that connects to `GET /api/conversations/:id/events`, collects frames with their `id:`
sequence, and can reconnect with `Last-Event-ID`. Needed for the snapshot/replay/dedupe rules in
`02-data-model.md` §5 — the most subtle behavior in the system and the one most likely to
regress silently.

### 3.6 Network boundary

No test performs real network I/O. `fetch` is injected (pi's `ProviderRequestOptions` accepts a
`fetch`, and piui's own `web_search`/`web_fetch`/HTTP-tool code MUST take an injectable fetch for
this reason). A test that needs a hostile response (redirect chain, private-IP DNS answer, huge
body, wrong content type) supplies it directly — that is how the SSRF rules in `11-security.md`
get tested at all.

## 4. Mocking policy

- **Do not mock the pi SDK.** Use a real `AgentSession` with the fake provider. Mocking pi would
  test piui's beliefs about pi rather than pi — and risk #1 in `13-open-questions.md` is exactly
  that pi's API drifts.
- **Do not mock SQLite.** Use the real file.
- **Do not mock the filesystem.** Use temp dirs.
- **Do mock/inject**: `fetch`, `Clock`, `IdGen`, and the `AuthProvider` when testing route
  authorization.
- Prefer **fakes over mocks**: a fake provider replaying a script beats assertions about calls.
  Assert on observable outcomes (HTTP responses, SSE frames, DB rows, files on disk), not on
  internal call counts.

## 5. Test taxonomy and where behavior belongs

| Layer | Tool | What belongs here | Speed budget |
|-------|------|-------------------|--------------|
| Unit | vitest | parsers (`parseMemory`, skill frontmatter), path validation, `resolveTools`, template/URL substitution, SSRF decisions, event projections (`event-map`, `transcript`), AuthFlow state machine, extension resolution | < 2 s total per file |
| Integration (server) | vitest + `fastify.inject()` + fake model | every route in `09-api.md`, authorization matrix, SSE lifecycle, conversation flows, credential flows, extension install/probe | whole suite < 60 s |
| Component (client) | vitest + `@testing-library/react` | `Composer` key semantics (Enter/Alt+Enter/Esc/Alt+Up), `SlashMenu` filtering and refusal of unknown commands, `useConversationStream` event application and dedupe, tool-card states | < 30 s |
| E2E | Playwright | the two flows in `12-milestones.md` only: login→chat→reload, and workspace→profile→agent-writes-a-file | < 3 min, runs in CI on PRs |

Golden/snapshot tests are allowed **only** for rendered Markdown and diff output, where the
assertion genuinely is "this text". Snapshots of API responses are forbidden — they pass on
wrong behavior and rot silently.

## 6. Recorded fixtures

- A committed pi session `.jsonl` (small, hand-trimmed, containing a tool call + result, a
  thinking block, and a compaction entry) so `transcript.ts` projection is tested against real
  pi output rather than piui's assumptions.
- A committed `AgentSessionEvent[]` capture for `event-map.ts`.
- Regenerating them is a documented script (`npm run fixtures:record`) that runs a real model
  once; the recording is reviewed by a human before commit, and never regenerated in CI.

## 7. What is exempt from test-first

Being honest here keeps the rule credible:

- **Visual design**: spacing, colors, theme tokens, icon choices. Behavior is tested; pixels are
  reviewed by eye.
- **Thin glue with no branching**: a route that only forwards to a tested domain function and a
  DTO mapping with no logic. If a bug is ever found in such glue, its fix starts with a test.
- **Generated or declarative artifacts**: the Dockerfile, compose file, and migrations — these
  are covered *behaviorally* by `19-deployment.md` §9 and by every test running migrations, not
  by unit tests of the YAML.
- **Third-party behavior**: don't test that Fastify routes or that SQLite persists.

## 8. CI gates

A PR merges only if: `lint` clean, `tsc --noEmit` clean (strict), unit + integration + component
suites green, `spec-coverage` green, E2E green, and the Docker image builds. Flaky tests are
**quarantined and fixed within the same milestone**, never re-run until green — a retry loop on a
streaming/SSE test would hide exactly the race it exists to catch.

Test execution must be deterministic: fixed seeds, fake clock, no real network, no reliance on
wall-clock ordering. Tests may run in parallel; each owns its own temp `PIUI_HOME` and DB, so
parallelism is safe by construction.

## 9. Acceptance criteria (for the method itself)

1. `npm test` runs unit + integration + component suites offline, with no network and no
   credentials configured, green, in under two minutes on a laptop.
2. `PIUI_FAKE_MODEL=1` exposes a scripted provider capable of driving: a streamed text answer, a
   multi-turn tool-calling loop where the real `write` and `bash` tools execute in a temp
   workspace, a provider error that triggers pi's auto-retry, and a stall that an abort
   interrupts.
3. No test reads or writes `~/.piui`, `~/.pi`, or any path outside `os.tmpdir()` — asserted by a
   guard in the global test setup that fails on access outside the temp root.
4. `spec-coverage` fails when an acceptance criterion is added to any spec file without a
   correspondingly tagged test or an entry in `test/spec-exemptions.ts`.
5. Every merge commit has a green suite; the repository history contains no commit that fails
   `npm test` on the default branch.
6. A deliberately introduced bug in each of `resolveTools`, path validation, the SSE dedupe rule,
   and the authorization scoping predicate causes at least one **named** test to fail — verified
   once by hand as a mutation-testing spot check per milestone, and recorded in the milestone
   notes.
