---
id: 00-overview
title: Overview
status: normative
read_first: true
summary: >-
  Goals, non-goals, glossary, architecture sketch, and the core product decisions that must not be re-litigated.
covers: [goals, non-goals, glossary, architecture, sdk-vs-rpc]
depends_on: []
required_by: [01-architecture, 02-data-model]
decisions: []
milestones: []
spec_version: 1
updated: 2026-02-20
---

# 00 — Overview

## 1. Goal

A single-user (for now), self-hosted web application that lets me:

- talk to a model in a **cheap, stateless chat** with optional web search, and
- run **full agentic tasks** in a chosen folder with a chosen "personality + capability bundle"
  (a **profile**),

without ever opening a terminal, while reusing `pi`'s agent loop, tool execution, session
persistence, model catalog, and credential handling instead of reimplementing them.

## 2. Non-goals for V1

- Multi-tenant / multi-user isolation (the auth layer is a placeholder — see `06-auth.md`).
- Remote/hosted deployment on the public internet. piui binds to `127.0.0.1` by default.
- Sandboxing the agent (pi's `bash`/`write` tools are as powerful as the user running piui).
- Mobile-first design (must merely not break on a tablet).
- Collaborative/simultaneous editing of the same conversation from two tabs.
- Vector stores, RAG, embeddings. "Persistent memory" in V1 is literally one Markdown file.
- Billing, quotas, usage caps (usage is *displayed* but not enforced).

## 3. Glossary

| Term | Meaning |
|------|---------|
| **pi** | The upstream coding agent package `@earendil-works/pi-coding-agent`. |
| **AgentSession** | pi SDK object owning one conversation, its messages, model, tools, compaction. |
| **pi session file** | The `.jsonl` append-only tree pi writes per conversation. |
| **Conversation** | A piui-level record that points at exactly one pi session file. |
| **Profile** | piui concept: `{ AGENTS.md text, selected skills, selected tools, memory on/off }`. |
| **Workspace** | piui concept: a named absolute directory used as the agent's `cwd`. |
| **Chat mode** | Conversation with a model + optional web search. No profile, no workspace, no memory, no filesystem tools. |
| **Agent mode** | Conversation with model + profile + workspace. Full pi tool set per profile. |
| **Memory file** | `memory.md` owned by a profile; append-only from the agent's point of view. |
| **Skill** | Agent Skills standard directory with a `SKILL.md` (see pi `docs/skills.md`). |
| **Tool** | Something the model can call. Either a pi built-in, a piui built-in, or a user-defined HTTP tool. |

## 4. High-level architecture

```
┌──────────────────────────── browser ────────────────────────────┐
│  React SPA (Vite)                                               │
│  - login, conversations list, chat view, profiles, workspaces,   │
│    skills, tools, settings                                       │
└───────── fetch (REST, JSON) ──────────  EventSource (SSE) ───────┘
                    │                             ▲
                    ▼                             │
┌──────────────────────── piui server (Node) ──────────────────────┐
│  HTTP layer (Fastify)                                            │
│   auth middleware · REST routes · /api/conversations/:id/events   │
│  ────────────────────────────────────────────────────────────────│
│  SessionHub: id -> LiveSession { AgentSession, subscribers,      │
│              ring buffer of ui events, seq counter }             │
│  ────────────────────────────────────────────────────────────────│
│  Builders: ProfileResolver · ToolRegistry · ModelService         │
│  Stores:   SQLite (metadata)  +  files (AGENTS.md, memory.md,    │
│                                    skills/, pi sessions/)        │
│  ────────────────────────────────────────────────────────────────│
│  @earendil-works/pi-coding-agent  (in-process SDK)               │
│     createAgentSession() / AgentSession / SessionManager /        │
│     ModelRuntime / DefaultResourceLoader / defineTool             │
└──────────────────────────────────────────────────────────────────┘
```

One Node process. No worker pool in V1: `AgentSession`s live in the main process, keyed by
conversation id. Concurrency comes from async I/O, and each conversation can have at most one
in-flight agent run (pi enforces this; piui surfaces it as `isStreaming`).

## 5. Why the SDK and not RPC mode

pi documents both. piui uses the **in-process SDK** because:

- piui needs to inject *per-conversation* tool sets, system prompts, skills and `cwd`, which
  `createAgentSession({ resourceLoader, customTools, tools, cwd })` supports directly;
  RPC mode would require one subprocess per conversation with bespoke CLI flags.
- Type safety on `AgentSessionEvent`.
- Direct access to `session.agent.state`, usage/cost, tree navigation.

The implementation MUST nonetheless keep all pi contact inside `server/src/pi/**` behind
narrow adapters (`AgentRunner`, `ModelService`, `ResourceBuilder`) so a future RPC or
per-conversation-subprocess backend is a drop-in replacement. No pi import is allowed outside
`server/src/pi/**`.

## 6. Core product decisions (do not re-litigate)

1. **Chat mode and agent mode are the same conversation machinery**, differing only in how the
   `AgentSession` is constructed (`SessionConfig`). There is one chat UI component.
2. **Profiles are mode-independent data.** A profile does not embed a model or a workspace;
   those are picked per conversation. This keeps profiles reusable.
3. **Skills are real files on disk** in a piui-managed directory, so they stay compatible with
   pi's CLI and with other harnesses. piui never invents a database-only skill format.
4. **Memory is a tool, not magic.** If a profile enables memory, piui injects a
   `memory_append` tool + a `<memory>` block in the system prompt. Nothing else changes.
5. **Every mutation of a conversation goes through the server**; the browser never touches the
   filesystem or the pi session file.
6. **Events are replayable.** Each conversation keeps a monotonic `seq`; SSE clients reconnect
   with `Last-Event-ID` and the server replays from its buffer, then sends a snapshot if the
   gap is too large. A tab refresh must never lose an in-flight answer.
