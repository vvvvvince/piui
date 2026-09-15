---
id: 02-data-model
title: Data model & storage
status: normative
summary: >-
  On-disk layout, full SQLite DDL, shared TypeScript domain types, and the UiMessage / UiEvent projections consumed by the frontend.
covers: [disk-layout, sqlite-schema, domain-types, ui-message, ui-event]
depends_on: [00-overview, 01-architecture]
required_by: [09-api, 10-frontend]
decisions: [Q1, Q2, Q3, Q7]
milestones: [M0]
spec_version: 1
updated: 2026-02-20
---

# 02 — Data model & storage

## 1. On-disk layout (`$PIUI_HOME`, default `~/.piui`)

```
~/.piui/
├── piui.db                         # SQLite: all metadata
├── agent/                          # passed to pi as agentDir
│   ├── settings.json               # piui-owned pi settings (may be absent)
│   └── sessions/                   # pi .jsonl session files (pi-managed)
├── profiles/
│   └── <profileId>/
│       ├── AGENTS.md               # profile persona/instructions (may be empty)
│       └── memory.md               # only if memory enabled; created on first append
├── extensions/                     # piui-managed extensions (spec 16)
│   └── <name>.ts
├── skills/
│   └── <skillDirName>/
│       ├── SKILL.md
│       └── ...                     # scripts/, references/, assets/ (freeform)
├── prompts/                         # piui-managed prompt templates (spec 15 §3.1)
│   └── <name>.md
├── uploads/<conversationId>/<uuid>.<ext>
├── scratch/<conversationId>/       # empty cwd for chat-mode sessions
└── logs/piui.log
```

Rules:
- `$PIUI_HOME/skills` is a normal pi skill directory: a user can point the pi CLI at it with
  `settings.json: { "skills": ["~/.piui/skills"] }`. Never store skill bodies only in SQLite.
- Profile files are the source of truth for their *content*; SQLite stores metadata and
  selections. On conflict (file edited outside piui), the file wins.
- Deleting a profile moves its directory to `$PIUI_HOME/trash/<profileId>-<ts>/` rather than
  `rm -rf`. Same for skills.

## 2. SQLite schema (`001_init.sql`)

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

-- Users & authorization (spec 18; decision Q7 = C) ---------------------------
-- V1 seeds exactly one admin. Ownership and role checks are ENFORCED from V1.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,            -- 'local' for the V1 seed
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL,               -- 'admin' | 'user'
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Owned tables below carry:
--   owner_id   TEXT NOT NULL REFERENCES users(id)
--   visibility TEXT NOT NULL DEFAULT 'private'   -- 'private' | 'shared'
-- Conversations are owned and always private (visibility column omitted).
-- See 18-multi-user.md §3–§4 for the scoping rule.

-- Profiles ------------------------------------------------------------------
CREATE TABLE profiles (
  id                TEXT PRIMARY KEY,           -- uuidv4
  owner_id          TEXT NOT NULL REFERENCES users(id),
  visibility        TEXT NOT NULL DEFAULT 'private',
  name              TEXT NOT NULL UNIQUE,
  description       TEXT NOT NULL DEFAULT '',
  memory_enabled    INTEGER NOT NULL DEFAULT 0, -- 0|1
  memory_path       TEXT,                       -- NULL => <profileDir>/memory.md
  include_discovered_skills INTEGER NOT NULL DEFAULT 0,  -- TUI-like: activate every discovered skill (spec 15 §3.2)
  allow_dynamic_extension_tools INTEGER NOT NULL DEFAULT 1,  -- allow late-registered extension tools (spec 16 §4)
  default_model     TEXT,                       -- "provider/modelId" hint, nullable
  default_thinking  TEXT,                       -- nullable
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE profile_skills (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  skill_id   TEXT NOT NULL REFERENCES skills(id)   ON DELETE CASCADE,
  PRIMARY KEY (profile_id, skill_id)
);

CREATE TABLE profile_tools (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,                     -- matches ToolDescriptor.name
  PRIMARY KEY (profile_id, tool_name)
);

-- Workspaces ----------------------------------------------------------------
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  visibility  TEXT NOT NULL DEFAULT 'private',
  name        TEXT NOT NULL UNIQUE,
  path        TEXT NOT NULL UNIQUE,             -- absolute, normalized, no trailing slash
  description TEXT NOT NULL DEFAULT '',
  trusted     INTEGER NOT NULL DEFAULT 0,       -- load project .pi/prompts + .pi/skills (spec 15 §3.3)
  trust_decided_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Skills (metadata mirror of the filesystem) --------------------------------
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  visibility  TEXT NOT NULL DEFAULT 'private',
  dir_name    TEXT NOT NULL UNIQUE,             -- folder under $PIUI_HOME/skills
  name        TEXT NOT NULL,                    -- frontmatter name
  description TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,       -- globally selectable
  source      TEXT NOT NULL DEFAULT 'managed',  -- 'managed' | 'external'
  ext_path    TEXT,                             -- absolute path when source='external'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- User-defined HTTP tools ---------------------------------------------------
CREATE TABLE http_tools (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  visibility   TEXT NOT NULL DEFAULT 'private',
  name         TEXT NOT NULL UNIQUE,            -- ^[a-z][a-z0-9_]{2,47}$
  label        TEXT NOT NULL,
  description  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  method       TEXT NOT NULL,                   -- GET|POST
  url_template TEXT NOT NULL,                   -- may contain {param}
  headers_json TEXT NOT NULL DEFAULT '{}',      -- values may contain ${ENV_VAR}
  body_template TEXT,                           -- JSON string with {param} placeholders
  params_json  TEXT NOT NULL,                   -- JSON Schema (object) for parameters
  timeout_ms   INTEGER NOT NULL DEFAULT 20000,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Extensions (spec 16) ------------------------------------------------------
CREATE TABLE extensions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,        -- ^[a-z0-9][a-z0-9._-]{0,63}$
  path          TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,               -- 'managed' | 'external'
  origin        TEXT,                        -- upload filename, URL, or registered path
  enabled       INTEGER NOT NULL DEFAULT 1,
  load_error    TEXT,
  tools_json    TEXT NOT NULL DEFAULT '[]',
  commands_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE profile_disabled_extensions (
  profile_id   TEXT NOT NULL REFERENCES profiles(id)   ON DELETE CASCADE,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, extension_id)
);

-- Conversations -------------------------------------------------------------
CREATE TABLE conversations (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES users(id),   -- always private (spec 18 §3)
  title          TEXT NOT NULL DEFAULT '',
  mode           TEXT NOT NULL,                 -- 'chat' | 'agent'
  provider       TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  thinking_level TEXT NOT NULL DEFAULT 'off',
  profile_id     TEXT REFERENCES profiles(id)   ON DELETE SET NULL,
  workspace_id   TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  web_search     INTEGER NOT NULL DEFAULT 0,
  session_path   TEXT,                          -- pi .jsonl path; NULL until first prompt
  archived       INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  tokens_total   INTEGER NOT NULL DEFAULT 0,
  cost_total     REAL    NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX conversations_recent ON conversations(owner_id, archived, last_message_at DESC);

-- Auth sessions (see 06-auth.md) -------------------------------------------
CREATE TABLE auth_sessions (
  id         TEXT PRIMARY KEY,                  -- random 32 bytes hex
  user_id    TEXT NOT NULL REFERENCES users(id),
  username   TEXT NOT NULL,                     -- denormalized for logs only
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  step_up_at TEXT,                              -- last password re-confirmation (14-credentials.md §5)
  user_agent TEXT
);
```

Notes:
- Message content is **not** duplicated in SQLite. The pi `.jsonl` is the transcript store.
  `conversations` caches only what a list view needs (title, timestamps, totals).
- `tokens_total` / `cost_total` are updated from pi's `get_session_stats` equivalent
  (`session` stats accessor) at the end of each run.
- Foreign keys MUST be enabled (`PRAGMA foreign_keys = ON`) and WAL mode set.
- **Ownership is enforced from V1** through a repository layer that takes the request principal;
  no route handler issues raw SQL against an owned table. Unique constraints on `name` are
  global in V1 and become per-owner in V2 (`18-multi-user.md` §8).

## 3. Shared TypeScript types (`shared/src/domain.ts`)

```ts
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  input: ("text" | "image")[];
  contextWindow: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  available: boolean;            // credentials present
}

export interface Owned {
  ownerId: string;
  visibility: "private" | "shared";
  isOwn: boolean;                // convenience for the client
}

export interface Profile extends Owned {
  id: string;
  name: string;
  description: string;
  agentsMd: string;              // full text (only in detail responses)
  skillIds: string[];
  toolNames: string[];
  memory: { enabled: boolean; path: string | null; sizeBytes?: number };
  defaults?: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel };
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  description: string;
  status: { exists: boolean; writable: boolean; isGitRepo: boolean; entryCount?: number };
  createdAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  dirName: string;
  name: string;
  description: string;
  enabled: boolean;
  source: "managed" | "external";
  path: string;
  files?: string[];              // relative paths, detail only
  warnings: string[];            // frontmatter/validation warnings
}

export type ToolKind = "builtin_pi" | "builtin_piui" | "http" | "extension";

export interface ToolDescriptor {
  name: string;                  // the name the model sees
  label: string;
  description: string;
  kind: ToolKind;
  enabled: boolean;              // globally
  selectableInProfile: boolean;
  dangerous: boolean;            // bash/write/edit/powershell/http tools
  configurable: boolean;         // http tools only
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: "chat" | "agent";
  model: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  profile?: { id: string; name: string };
  workspace?: { id: string; name: string; path: string };
  webSearch: boolean;
  archived: boolean;
  isStreaming: boolean;
  lastMessageAt: string | null;
  tokensTotal: number;
  costTotal: number;
  createdAt: string;
}
```

## 4. UiMessage — the transcript shape the frontend consumes

The frontend never parses pi `AgentMessage`s. The server projects them.

```ts
// shared/src/events.ts
export type UiBlock =
  | { type: "text";     id: string; text: string }
  | { type: "thinking"; id: string; text: string; collapsedByDefault: true }
  | { type: "tool";     id: string; toolCallId: string; name: string; label: string;
      args: unknown; argsText?: string;                 // argsText while streaming
      state: "pending" | "running" | "ok" | "error";
      output?: string; outputTruncated?: boolean; details?: unknown; durationMs?: number };

export interface UiMessage {
  id: string;                    // pi entry id when available, else generated
  role: "user" | "assistant" | "system" | "bash" | "error";
  blocks: UiBlock[];
  /** Set when the text was produced by expanding a skill/template command (spec 15 §1.3). */
  commandEcho?: { typed: string; expandedChars: number };
  attachments?: { id: string; kind: "image"; mimeType: string; url: string }[];
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  model?: string;
  createdAt: string;
  streaming?: boolean;
}
```

Projection rules (`session/transcript.ts` + `session/event-map.ts`):
- `thinking` blocks are kept but rendered collapsed. If model output has none, no block.
- Tool call + its `toolResult` are merged into **one** `tool` block on the assistant message.
  Never render a separate "tool result" message.
- `role: "bash"` covers pi `BashExecutionMessage` (from a future terminal feature); V1 may
  simply skip these but the type MUST exist.
- Assistant error / `stopReason: "error"` becomes a `role: "error"` message with the text.
- Tool `output` is truncated to 16 KB for the snapshot; full output fetched on demand via
  `GET /api/conversations/:id/tool-output/:toolCallId` `[LATER]` — V1 may just truncate and say so.

## 5. UiEvent — the SSE union

```ts
export type UiEvent =
  | { type: "snapshot"; seq: number; messages: UiMessage[]; state: ConversationRuntimeState }
  | { type: "state";    seq: number; state: ConversationRuntimeState }
  | { type: "message_start"; seq: number; message: UiMessage }
  | { type: "block_start";   seq: number; messageId: string; block: UiBlock }
  | { type: "block_delta";   seq: number; messageId: string; blockId: string;
      textDelta?: string; argsDelta?: string }
  | { type: "block_end";     seq: number; messageId: string; block: UiBlock }
  | { type: "message_end";   seq: number; message: UiMessage }
  | { type: "tool_update";   seq: number; messageId: string; blockId: string; block: UiBlock }
  | { type: "queue";   seq: number; steering: string[]; followUp: string[] }
  // Extension UI bridge (spec 16 §5)
  | { type: "ui_request"; seq: number; requestId: string;
      method: "select" | "confirm" | "input" | "editor";
      title?: string; message?: string; options?: string[]; placeholder?: string;
      prefill?: string; timeoutMs?: number }
  | { type: "ui_request_resolved"; seq: number; requestId: string }
  | { type: "status"; seq: number; key: string; text: string | null }
  | { type: "widget"; seq: number; key: string; lines: string[] | null;
      placement: "aboveEditor" | "belowEditor" }
  | { type: "notice"; seq: number; level: "info" | "warning" | "error"; text: string }
  | { type: "usage";  seq: number; tokensTotal: number; costTotal: number;
      contextPercent: number | null }
  | { type: "title";  seq: number; title: string }
  | { type: "done";   seq: number; reason: "settled" | "aborted" | "error" }
  | { type: "ping";   seq: number };

export interface ConversationRuntimeState {
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  queued: { steering: number; followUp: number };
  contextPercent: number | null;
}
```

Guarantees:
- `seq` is strictly increasing per conversation, starts at 1, resets only when the server
  restarts (a restart MUST cause reconnecting clients to receive a fresh `snapshot`).
- A client that connects mid-run receives `snapshot` first (including the partial streaming
  assistant message), then live deltas.
- `ping` every 20 s to keep proxies from closing the stream.
