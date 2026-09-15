---
id: 01-architecture
title: Architecture, stack, repo layout
status: normative
summary: >-
  Technology choices, repository layout, environment configuration, and the contract with the pi SDK (SessionConfig, ResourceLoader, event flow, lifecycle, concurrency).
covers: [stack, repo-layout, env-config, pi-integration, resource-loader, event-flow, concurrency]
depends_on: [00-overview]
required_by: [02-data-model, 09-api, 16-extensions, 19-deployment]
decisions: [Q1, Q2, Q3, Q10]
milestones: [M0, M2]
spec_version: 1
updated: 2026-02-20
---

# 01 — Architecture, stack, repo layout

## 1. Stack (normative)

**Server**
- Node.js >= 22, TypeScript, ESM (`"type": "module"`), `tsx` for dev, `tsc` for build.
- HTTP: **Fastify 5** (`@fastify/cookie`, `@fastify/static`, `@fastify/multipart` for image upload).
- Agent: `@earendil-works/pi-coding-agent` (pin the installed version, currently `0.85.x`).
- Metadata store: **SQLite** via `better-sqlite3`, single file `$PIUI_HOME/piui.db`.
  Migrations: plain numbered SQL files applied in a transaction at boot (`server/src/db/migrations/NNN_*.sql`), tracked in a `schema_migrations` table.
- Validation: **TypeBox** (already a pi dependency, and pi's `defineTool` uses it) + `ajv` for request bodies. Do not add zod.
- Logging: `pino` (pretty in dev). One log line per request; agent events at `debug`.
- Tests: `vitest` for unit/integration, `supertest`-style via `fastify.inject()`,
  `@testing-library/react` for components, Playwright for the two E2E flows.
  **Development is test-first** — [20-development-method.md](20-development-method.md) is
  normative, and its §3 test seams (scripted fake provider, temp `PIUI_HOME`, injectable
  clock/ids/fetch, principal injection, SSE harness) are M0 deliverables. Design consequence:
  `web_search`, `web_fetch` and HTTP tools MUST accept an injectable `fetch`, and all time and
  id generation MUST go through injected `Clock`/`IdGen`.

**Client**
- React 18 + TypeScript + **Vite**.
- Routing: `react-router` v6.
- Server state: **TanStack Query** for REST; a hand-written `EventSource` hook for streams.
- Styling: **Tailwind CSS**. Component primitives: headless (`radix-ui`) where a dialog/menu/toast is needed. No heavyweight component kit.
- Markdown rendering: `react-markdown` + `remark-gfm` + `shiki` (or `highlight.js`) for code blocks. Rendering MUST sanitize HTML (`rehype-sanitize`) — model output is untrusted.
- Editor for AGENTS.md / SKILL.md: **CodeMirror 6** (markdown mode). No Monaco.

**Dev ergonomics**
- `npm run dev` starts server (`:8787`) and Vite (`:5173`) concurrently; Vite proxies `/api` to the server.
- `npm run build` emits `client/dist` and `server/dist`; production server serves the SPA statically from one port.
- `biome` or `eslint+prettier` — pick one, enforce in CI. Formatting: tabs or 2-space spaces, be consistent.

## 2. Repository layout

```
piui/
├── package.json                 # npm workspaces: server, client, shared
├── shared/
│   └── src/
│       ├── api.ts               # request/response DTOs (source of truth for both sides)
│       ├── events.ts            # UiEvent union (SSE payloads)
│       └── domain.ts            # Profile, Workspace, Tool, Skill, Conversation types
├── server/
│   ├── src/
│   │   ├── index.ts             # boot: config, db, hub, fastify, graceful shutdown
│   │   ├── config.ts            # env parsing + defaults (PIUI_HOME, PORT, ...)
│   │   ├── db/
│   │   │   ├── index.ts         # better-sqlite3 open + migrate
│   │   │   └── migrations/001_init.sql
│   │   ├── http/
│   │   │   ├── auth.ts          # login/logout, cookie session, preHandler guard
│   │   │   ├── routes.*.ts      # one file per resource (see 09-api.md)
│   │   │   └── sse.ts           # SSE transport helper
│   │   ├── domain/
│   │   │   ├── profiles.ts      # CRUD + validation + file side-effects
│   │   │   ├── workspaces.ts
│   │   │   ├── skills.ts        # filesystem-backed skill CRUD + frontmatter parse
│   │   │   ├── tools.ts         # ToolRegistry: catalog + resolution
│   │   │   ├── extensions.ts    # install/probe/enumerate, per-profile disable (spec 16)
│   │   │   └── conversations.ts
│   │   ├── session/
│   │   │   ├── hub.ts           # SessionHub, LiveSession, event fan-out, idle eviction
│   │   │   ├── event-map.ts     # AgentSessionEvent -> UiEvent projection
│   │   │   └── transcript.ts    # pi messages -> UiMessage[] snapshot
│   │   └── pi/                  # THE ONLY PLACE THAT IMPORTS pi
│   │       ├── agent-runner.ts  # createAgentSession wrapper, prompt/steer/abort
│   │       ├── model-service.ts # ModelRuntime wrapper: list/validate models
│   │       ├── credentials.ts   # CredentialService: provider status + login AuthFlow (spec 14)
│   │       ├── resources.ts     # DefaultResourceLoader construction per SessionConfig
│   │       └── tools/
│   │           ├── web-search.ts    # defineTool web_search / web_fetch
│   │           ├── memory.ts        # defineTool memory_append
│   │           └── http-tool.ts     # factory for user-defined HTTP tools
│   └── test/
├── client/
│   ├── index.html
│   └── src/
│       ├── main.tsx, routes.tsx
│       ├── api/                 # typed fetch wrappers + query hooks
│       ├── hooks/useConversationStream.ts
│       ├── pages/               # Login, Conversations, Chat, Profiles, Workspaces, Skills, Tools, Settings
│       └── components/          # MessageList, ToolCallCard, Composer, ModelPicker, ...
└── spec/                        # this directory
```

## 3. Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PIUI_HOME` | `~/.piui` | Root for db, profiles, skills, sessions, logs. |
| `PIUI_PORT` | `8787` | HTTP port. |
| `PIUI_HOST` | `127.0.0.1` | Bind address. Refuse to start on `0.0.0.0` unless `PIUI_ALLOW_REMOTE=1`. |
| `PIUI_CONTAINER` | unset | Set by the shipped image. Downgrades the remote-bind warning to an info line (inside a container the network namespace is the boundary) and is reported by `/api/health`. See [19-deployment.md](19-deployment.md) §5. |
| `PIUI_INSECURE_TRANSPORT_OK` | unset | Operator acknowledgement that plaintext HTTP is acceptable for this deployment; required for credential writes when requests do not arrive over HTTPS. Set by the shipped compose file, which publishes to loopback only. |
| `PIUI_SESSION_SECRET` | random per boot | HMAC key for the auth cookie. If unset, log a warning (sessions die on restart). |
| `PIUI_AGENT_DIR` | `$PIUI_HOME/agent` | Passed to pi as `agentDir`. Holds pi `settings.json`, `sessions/`. |
| `PIUI_PI_AUTH_PATH` | `~/.pi/agent/auth.json` | Reuse the user's existing pi credentials by default; keys added in the UI are written here. Set to `$PIUI_HOME/auth.json` to isolate from the CLI. |
| `PIUI_DISABLE_CREDENTIAL_WRITES` | unset | `1` disables all provider-credential write routes (`403`). Recommended for exposed deployments. |
| `PIUI_DISABLE_EXTENSION_INSTALL` | unset | `1` disables all extension mutation routes (`403`). Status and per-profile disabling still work. |
| `PIUI_WORKSPACE_ROOTS` | *(empty = any absolute path)* | Colon-separated allowlist of parent dirs for workspaces. |
| `PIUI_SEARCH_PROVIDER` | `brave` | `brave` \| `tavily` \| `searxng` \| `none`. |
| `PIUI_SEARCH_API_KEY` | — | Key for the chosen provider. |
| `PIUI_SEARXNG_URL` | — | Only for `searxng`. |
| `PIUI_MAX_UPLOAD_MB` | `10` | Per-image upload limit. |

Config is parsed once into a frozen object; no `process.env` reads elsewhere.

## 4. pi integration contract

### 4.1 `SessionConfig` — the single input to session construction

```ts
// shared/src/domain.ts
export type SessionMode = "chat" | "agent";

export interface SessionConfig {
  mode: SessionMode;
  model: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;          // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  profileId?: string;                    // agent mode only
  workspaceId?: string;                  // agent mode only
  webSearch: boolean;                    // chat mode: user toggle; agent mode: from profile tools
}
```

`server/src/pi/agent-runner.ts` MUST expose exactly:

```ts
export interface CreateSessionInput {
  config: ResolvedSessionConfig;   // profile + workspace already loaded, tools already resolved
  sessionManager: SessionManagerLike;  // new file, or open existing path
}
export interface AgentRunnerHandle {
  session: AgentSession;
  dispose(): void;
}
export function createSession(input: CreateSessionInput): Promise<AgentRunnerHandle>;
```

### 4.2 How each pi knob is used

| pi option | piui value |
|-----------|-----------|
| `cwd` | Agent mode: workspace path. Chat mode: a per-conversation scratch dir `$PIUI_HOME/scratch/<conversationId>` (empty, so pi discovers nothing). |
| `agentDir` | `config.agentDir` (`$PIUI_HOME/agent`). |
| `model`, `thinkingLevel` | From `SessionConfig`, resolved through `ModelService`. |
| `modelRuntime` | One shared `ModelRuntime` for the whole process, created at boot with `authPath: config.piAuthPath`. |
| `tools` | Explicit allowlist of *enabled* tool names (built-ins + custom). See `05-skills-and-tools.md`. Chat mode: `[]` plus web tools. |
| `customTools` | Array from `ToolRegistry.resolve(profile)` — `web_search`, `web_fetch`, `memory_append`, user HTTP tools. |
| `resourceLoader` | A `DefaultResourceLoader` built per conversation (see 4.3). |
| `sessionManager` | `SessionManager.create(cwd)` for new conversations; `SessionManager.open(path)` when reviving. |
| `settingsManager` | `SettingsManager.inMemory({...})` — piui owns settings; never mutate the user's global pi settings. `enableSkillCommands: true` (required by decision Q2), `steeringMode`/`followUpMode` from piui settings, `enableInstallTelemetry: false`. |

### 4.3 ResourceLoader per conversation

piui does **not** want pi's ambient discovery (user's `~/.pi/agent/extensions`, project
`.pi/`, ancestor `.agents/skills`) leaking into a conversation, because the profile is the
source of truth. Construct the loader with explicit overrides:

```ts
const loader = new DefaultResourceLoader({
  cwd, agentDir,
  settingsManager,
  systemPromptOverride: () => buildSystemPrompt(resolved),   // see 03 + 07
  skillsOverride: () => ({ skills: resolved.skills, diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: resolved.agentsFiles }),
  promptsOverride: (cur) => ({ prompts: resolved.prompts, diagnostics: cur.diagnostics }),
});
await loader.reload();
```

**Amended by decision Q2 (TUI parity, see [15-commands-and-input.md](15-commands-and-input.md)
§3):** prompt templates are *not* suppressed. `resolved.prompts` composes
`$PIUI_HOME/prompts`, `~/.pi/agent/prompts`, and `<workspace>/.pi/prompts` when the workspace is
trusted. Skills discovered in `~/.pi/agent/skills`, `~/.agents/skills` and trusted project dirs
enter the piui **catalog** but are still activated per profile (or wholesale via the profile's
`includeDiscoveredSkills` flag). Extensions and project `.pi/settings.json` remain fully
suppressed.

- `resolved.skills` are `Skill` objects built from the profile's selected skill directories
  (`{ name, description, filePath, baseDir, source: "custom" }`).
- `resolved.agentsFiles` is `[{ path: "<profileDir>/AGENTS.md", content }]` in agent mode when
  the profile's AGENTS.md is non-empty; `[]` in chat mode.
- Extensions: none in V1 (`additionalExtensionPaths: []`, `extensionFactories: []`).
  Implementation MUST verify (test) that no host extension is loaded.
- If `DefaultResourceLoader` cannot fully suppress ambient discovery, implement a small
  `ResourceLoader` class satisfying pi's `ResourceLoader` interface instead. Verify against
  the installed `dist/index.d.ts`.

### 4.4 Event flow

```
AgentSession.subscribe(e => hub.ingest(conversationId, e))
   -> event-map.ts projects AgentSessionEvent -> UiEvent[] (0..n)
   -> LiveSession.seq++ ; push to ring buffer (cap 2000 events or 8 MB)
   -> write to every attached SSE subscriber as: id: <seq>\ndata: <json>\n\n
```

Text deltas are **coalesced**: the projector buffers `text_delta`/`thinking_delta` and flushes
at most every 50 ms (or 1 KB) per content block, to avoid one SSE frame per token.

### 4.5 Lifecycle & eviction

- `LiveSession` is created lazily on first prompt or first SSE attach for a conversation.
- Eviction: if `!isStreaming` and no subscriber for **15 min**, call `session.dispose()` and
  drop from the hub (the pi `.jsonl` file remains; the conversation is revivable).
- Graceful shutdown: `abort()` all streaming sessions, `dispose()` all, close db, exit.
- Crash safety: on boot, nothing to recover — conversations are rebuilt from session files.

## 5. Concurrency rules

- One in-flight run per conversation. A `prompt` while `isStreaming` MUST be translated to
  `steer` or `followUp` per the request's `streamingBehavior`, matching pi's semantics;
  absent that field the API returns `409 conversation_busy`.
- Multiple conversations may stream concurrently; cap with a semaphore
  (`PIUI_MAX_CONCURRENT_RUNS`, default 4) and return `429` beyond it.
- All filesystem writes to a profile's `memory.md` go through a per-profile async mutex.
