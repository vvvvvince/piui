-- M6: the skill test run (spec/05-skills-and-tools.md §A.4) is a throwaway conversation —
-- not listed, swept an hour after it was created, and carrying the one skill it exercises.
ALTER TABLE conversations ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN skill_id TEXT;
-- The tools the test run granted (`["read"]`, plus `bash` when the user ticked it), so a
-- revived session rebuilds with the same allowlist.
ALTER TABLE conversations ADD COLUMN ephemeral_tools TEXT;
