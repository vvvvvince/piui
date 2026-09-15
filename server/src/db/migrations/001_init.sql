-- 001_init.sql — full schema from spec/02-data-model.md §2 (+ spec/18-multi-user.md §8).

-- Users & authorization (spec 18; decision Q7 = C) ---------------------------
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Profiles ------------------------------------------------------------------
CREATE TABLE profiles (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id),
  visibility        TEXT NOT NULL DEFAULT 'private',
  name              TEXT NOT NULL UNIQUE,
  description       TEXT NOT NULL DEFAULT '',
  memory_enabled    INTEGER NOT NULL DEFAULT 0,
  memory_path       TEXT,
  include_discovered_skills INTEGER NOT NULL DEFAULT 0,
  allow_dynamic_extension_tools INTEGER NOT NULL DEFAULT 1,
  default_model     TEXT,
  default_thinking  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Skills (metadata mirror of the filesystem) --------------------------------
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  visibility  TEXT NOT NULL DEFAULT 'private',
  dir_name    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL DEFAULT 'managed',
  ext_path    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE profile_skills (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  skill_id   TEXT NOT NULL REFERENCES skills(id)   ON DELETE CASCADE,
  PRIMARY KEY (profile_id, skill_id)
);

CREATE TABLE profile_tools (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  PRIMARY KEY (profile_id, tool_name)
);

-- Workspaces ----------------------------------------------------------------
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  visibility  TEXT NOT NULL DEFAULT 'private',
  name        TEXT NOT NULL UNIQUE,
  path        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  trusted     INTEGER NOT NULL DEFAULT 0,
  trust_decided_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- User-defined HTTP tools ---------------------------------------------------
CREATE TABLE http_tools (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  visibility   TEXT NOT NULL DEFAULT 'private',
  name         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  description  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  method       TEXT NOT NULL,
  url_template TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}',
  body_template TEXT,
  params_json  TEXT NOT NULL,
  timeout_ms   INTEGER NOT NULL DEFAULT 20000,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Extensions (spec 16) ------------------------------------------------------
CREATE TABLE extensions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,
  origin        TEXT,
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
  owner_id       TEXT NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL DEFAULT '',
  mode           TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  thinking_level TEXT NOT NULL DEFAULT 'off',
  profile_id     TEXT REFERENCES profiles(id)   ON DELETE SET NULL,
  workspace_id   TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  web_search     INTEGER NOT NULL DEFAULT 0,
  session_path   TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  tokens_total   INTEGER NOT NULL DEFAULT 0,
  cost_total     REAL    NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX conversations_recent ON conversations(owner_id, archived, last_message_at DESC);

-- Auth sessions (spec 06) ---------------------------------------------------
CREATE TABLE auth_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  step_up_at TEXT,
  user_agent TEXT
);
