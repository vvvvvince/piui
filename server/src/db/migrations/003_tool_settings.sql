-- M3: global enable/disable for catalog tools (spec/05-skills-and-tools.md §B.2,
-- spec/09-api.md §7 `PATCH /api/tools/:name`). `02-data-model.md` has no table for this:
-- built-ins have no row anywhere, so the flag needs its own (name, enabled) store.
-- Absence of a row means "enabled", so the table only ever holds deviations from the default.
CREATE TABLE tool_settings (
  name       TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
