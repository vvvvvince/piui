---
id: 13-open-questions
title: Open questions & deferrals
status: informative
summary: >-
  Unanswered product questions with default assumptions, the deliberate [LATER] list with its hooks, and known risks.
covers: [open-questions, later-list, risks]
depends_on: []
required_by: []
decisions: [Q8, Q10]
milestones: []
spec_version: 1
updated: 2026-02-20
---

# 13 — Open questions & deliberate deferrals

## A. Questions for the spec owner (answer before or during M2/M5)

Answered questions move to [decisions.md](decisions.md) — read it first; it is binding.

1. ~~**Provider credentials in the UI**~~ — **ANSWERED: Option B.** API-key management in the
   UI with step-up re-auth and a kill switch; OAuth deferred. See
   [decisions.md](decisions.md#q1--provider-credentials-in-the-ui--option-b) and the new
   [14-credentials.md](14-credentials.md).
2. ~~**Skill commands**~~ — **ANSWERED: TUI parity.** Full `/` command surface, pi's queue key
   semantics, TUI-like prompt-template discovery, skills discovered-into-catalog /
   activated-per-profile, workspace trust. See
   [decisions.md](decisions.md#q2--slash-commands--prompt-templates--tui-parity) and
   [15-commands-and-input.md](15-commands-and-input.md).
3. ~~**pi extensions**~~ — **ANSWERED: global + UI-installable + per-profile disable, no
   approval gates.** See
   [decisions.md](decisions.md#q3--pi-extensions--global-ui-installable-per-profile-disable-no-gates)
   and [16-extensions.md](16-extensions.md).
4. ~~**Memory evolution**~~ — **ANSWERED: Option D (hybrid, phased).** Pinned + recency, then
   FTS5 search; append-only forever; V1 fixes the file format so no migration is needed. See
   [decisions.md](decisions.md#q4--memory-evolution--option-d-hybrid-phased) and
   [17-memory.md](17-memory.md).
5. ~~**Per-workspace memory**~~ — **ANSWERED: Option A, per profile only.** The two-scope
   variant is designed as a pure addition (see the `[LATER]` table below). See
   [decisions.md](decisions.md#q5--per-workspace-memory--option-a-per-profile-only).
6. ~~**Chat mode extras**~~ — **ANSWERED: Option A, no persona in chat mode.** Use a
   capability-free profile in agent mode instead. See
   [decisions.md](decisions.md#q6--chat-mode-personality--option-a-keep-chat-clean) and
   [07-chat-mode.md](07-chat-mode.md) §1.1.
7. ~~**Multi-user**~~ — **ANSWERED: Option C.** Real multi-user is planned; ownership and role
   checks are enforced from V1, users/auth-providers/sharing UI land in V2. See
   [decisions.md](decisions.md#q7--multi-user--option-c-plan-it-enforce-the-model-from-v1) and
   [18-multi-user.md](18-multi-user.md).
8. **Model for titles and compaction** — use the conversation's model (simple, costly) or a
   configured cheap model (`PIUI_TITLE_MODEL`)? Spec supports both; default is the
   conversation's model.
9. ~~**Approval gates for dangerous commands**~~ — **ANSWERED by Q3: never.** piui ships no
   tool-call confirmation logic. Gating is a user-installed extension's job.
10. **Sandboxing** — should agent mode eventually run pi inside a container (pi documents
    containerization)? That changes `AgentRunner` from in-process SDK to per-conversation
    subprocess/RPC. The architecture keeps it possible; nothing in V1 implements it.

## B. Deliberate `[LATER]` list (do not build now, do not design them out)

| Item | Hook already in the spec |
|------|--------------------------|
| Session forking / branch navigator | `POST /api/conversations/:id/fork`, `GET .../tree`, pi `AgentSessionRuntime.fork` |
| Retry a message / edit-and-resend | pi fork semantics; `MessageBubble` actions |
| MCP server integration as a tool kind | `ToolKind` union gains `"mcp"`; `ToolRegistry` already abstracts resolution |
| Terminal panel in the workspace (`bashExecution` messages) | `UiMessage.role: "bash"` exists |
| Scheduled / triggered agent runs | conversation creation is already an API call |
| Sub-agents (a tool that spawns a session) | pi SDK supports it via nested `createAgentSession` |
| Skill registry / git install | `POST /api/skills/import` gains a `gitUrl` variant |
| OAuth / subscription login in the UI | `14-credentials.md` §8 — flow driver already handles `auth_url`/`device_code`/`manual_code` |
| `models.json` custom provider editing | `ModelRuntime({ modelsPath })`; a future `/api/settings/models-json` |
| Per-conversation chat instructions (Q6 option B) | a `conversations.instructions` column + the existing chat prompt composer |
| Scoped (per profile × workspace) memory | `memory_append({ scope })` + a second injected block + `<profileDir>/memory/<workspace-slug>.md`; no migration ([17-memory.md](17-memory.md) §6) |
| Multi-user: user CRUD, htpasswd/OIDC providers, sharing UI, per-user credentials & quotas | [18-multi-user.md](18-multi-user.md) §7 |
| Container/remote execution | `AgentRunner` interface |
| Trash management UI | `$PIUI_HOME/trash/` + a maintenance endpoint |
| Voice input / TTS | none needed |

## C. Known risks

1. **pi API drift.** piui pins `@earendil-works/pi-coding-agent` and MUST have a smoke test
   asserting the shape it depends on (`createAgentSession` options, `AgentSessionEvent`
   variants, `DefaultResourceLoader` override names, built-in tool names). Read
   `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` before implementing
   `server/src/pi/**` and correct this spec where it disagrees.
2. **Suppressing ambient resource discovery** may not be fully possible with
   `DefaultResourceLoader` overrides; fallback is a custom `ResourceLoader` implementation.
   Verify early (M2) — it affects the profile guarantee.
3. **Delta volume.** Without coalescing, a fast model plus a chatty `bash` tool will flood SSE
   and jank the UI. The 50 ms / 1 KB coalescing is not optional.
4. **Memory injection cost.** Every request in a memory-enabled profile carries the memory
   file. The 32 KB cap and the UI surfacing of file size exist to keep this visible.
5. **Single-process blast radius.** One bad tool can stall the event loop (huge sync file read).
   Keep all piui-side tool work async and bounded; consider `worker_threads` only if measured.
