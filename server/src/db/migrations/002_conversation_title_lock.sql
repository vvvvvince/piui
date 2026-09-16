-- M2: the auto-title is generated from the first user message only, and never overwrites a
-- title the user set (spec/07-chat-mode.md §3, decision Q8).
ALTER TABLE conversations ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN timezone TEXT;
