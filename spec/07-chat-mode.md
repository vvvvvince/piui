---
id: 07-chat-mode
title: Chat mode
status: normative
feature: "4 — Chat mode"
summary: >-
  Feature 4. Model + optional web search, no profile/workspace/memory/filesystem; custom system prompt, cost discipline, scratch cwd hygiene.
covers: [chat-mode, system-prompt, web-search-ui, scratch-cwd]
depends_on: [01-architecture, 05-skills-and-tools]
required_by: []
decisions: [Q2, Q6, Q8]
milestones: [M2, M3]
spec_version: 1
updated: 2026-02-20
---

# 07 — Chat mode (Feature 4)

> "Pick a model, talk. Optionally let it search the web. No persona, no profile, no memory,
> no filesystem."

## 1. What chat mode is

A conversation created with `mode: "chat"`:

| Aspect | Value |
|--------|-------|
| model | user-selected, changeable mid-conversation |
| thinking level | user-selected, changeable mid-conversation |
| profile | **none** (field forbidden in the create request → `400`) |
| workspace | **none** (field forbidden → `400`) |
| AGENTS.md / context files | **none** |
| skills | **none** |
| memory | **none** |
| tools | `[]`, plus `web_search` + `web_fetch` when the web-search toggle is on |
| cwd | `$PIUI_HOME/scratch/<conversationId>` (created empty, never populated) |
| persistence | pi session file, same as agent mode (history survives restarts) |

### 1.1 No persona, by decision (Q6)

Chat mode has **no** persona, instructions field, or preset. The system prompt in §2 is fixed
(modulo the web-search block). There is no per-conversation free-text instruction box, no chat
presets, and profiles are **not** applicable to chat mode.

If a framing is wanted, the supported route is **agent mode with a capability-free profile**:
`toolNames: []`, no skills, memory off, any workspace. That is already a valid profile
(`03-profiles.md` §4 explicitly allows an empty tool selection) and needs no new concept.

Rationale, so this is not re-opened by accident: a partially-applied `AGENTS.md` — written
assuming tools exist (*"use `read` before editing"*) — produces a chat assistant that
confidently offers to edit files it cannot see. Chat mode's value is that it is cheap and
predictable; the fixed prompt is what guarantees that.

## 2. System prompt

Chat mode MUST NOT use pi's coding-agent system prompt (it talks about tools, workspaces and
engineering conventions that do not apply). Use
`DefaultResourceLoader({ systemPromptOverride })` with:

```
You are a helpful assistant answering questions in a web chat interface.

- Answer directly and concisely. Expand only when the question needs it.
- Use Markdown: fenced code blocks with a language, tables when comparing, short lists.
- Render math as LaTeX in $…$ / $$…$$.
- If you are unsure or the answer depends on recent information, say so.
{{WEB_SEARCH_BLOCK}}
- You have no access to the user's files, terminal, or any persistent memory. Do not claim
  otherwise and do not offer to modify files.
- Today's date is {{DATE}}. The user's timezone is {{TZ}}.
```

`{{WEB_SEARCH_BLOCK}}` when web search is enabled:

```
- You can call `web_search` to find pages and `web_fetch` to read one. Search when the question
  concerns current events, versions, prices, docs, or anything you might have stale knowledge
  about. Prefer one or two focused searches over many. Always cite the sources you used as
  Markdown links at the end under a "Sources" heading.
```

and when disabled:

```
- You have no web access in this conversation. If a question requires current information, say
  that the user can enable web search with the toggle in the composer.
```

`{{DATE}}` = ISO date, `{{TZ}}` = timezone sent by the client at conversation creation
(`Intl.DateTimeFormat().resolvedOptions().timeZone`), defaulting to the server's.

## 3. UI specifics

- **New chat** dialog: model picker (searchable, grouped by provider, unavailable models greyed
  with "no credentials"), thinking level selector (only for reasoning models, from
  `ModelInfo.thinkingLevels`), web-search toggle. "Start chat".
- Composer: multiline textarea (Enter = send, Shift+Enter = newline, Cmd/Ctrl+Enter = send),
  attach-image button (only when `ModelInfo.input` includes `"image"`, else disabled with a
  tooltip), a **globe toggle** mirroring `webSearch`, model chip that opens the picker inline.
- Changing the model or the toggle mid-conversation:
  - `PATCH /api/conversations/:id` → applies from the **next** prompt,
  - emits a `notice` event rendered as an inline divider in the transcript:
    *"Switched to claude-opus-4-5"*, *"Web search enabled"*. History is never rewritten.
  - Changing the model while streaming returns `409 conversation_busy`.
- Web search tool cards render specially: the `web_search` card shows the query and a compact
  list of result titles as links; `web_fetch` shows the final URL, status and char count. Both
  are collapsed by default once complete.
- A **Sources** footer: the client collects URLs from `web_search`/`web_fetch` tool blocks of
  the current assistant message and renders favicon + domain chips under the answer, even if
  the model forgot to cite.
- Title: generated from the **first user message only**, fired as soon as that message is
  accepted (not after the answer), via a direct one-shot model call with no tools and no session
  — shared implementation in `08-agent-mode.md` §7 (decision Q8).

## 4. Cost discipline

- Chat mode MUST NOT send the pi coding system prompt, skills XML, AGENTS.md, or memory — this
  is the whole reason chat mode exists. A unit test MUST assert the system prompt in chat mode
  does not contain the strings from pi's default coding prompt and that
  `resolveTools({mode:"chat", webSearch:false})` returns zero tools.
- Compaction: enabled with pi defaults, but for chat the threshold can stay default; show a
  context-usage bar in the header (`usage` events) turning amber > 70 %, red > 90 %.
- Show per-message token/cost on hover of the assistant message footer, and cumulative
  cost in the conversation header.

## 5. Scratch cwd hygiene

- Created on first prompt, `0o700`.
- Deleted when the conversation is deleted, and swept on boot for conversations that no longer
  exist.
- It exists only because pi requires a `cwd`; nothing may be written there. Since chat mode has
  no filesystem tools, nothing can be.

## 6. Acceptance criteria

1. Create a chat, ask "what model are you?" → streams tokens visibly, saves to a pi session,
   survives a page reload (snapshot replay) and a server restart (rehydrate from session file).
2. With web search **off**, ask "what is the latest Node LTS?" → the answer states it may be
   stale and mentions the toggle; no tool call appears.
3. With web search **on**, the same question produces a `web_search` card, a Sources footer with
   at least one link, and the answer references them.
4. Attaching a PNG to a vision-capable model works; the image is displayed in the user bubble
   and stored under `$PIUI_HOME/uploads/<conversationId>/`.
5. Sending a second prompt while the first is streaming shows the queued-message chip and is
   delivered as a follow-up (or steers, per the chosen behavior) exactly once.
6. Pressing Stop aborts within ~1 s; the partial assistant message remains in the transcript
   marked "stopped".
