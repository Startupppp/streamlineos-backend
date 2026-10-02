-- Rollback for 1154a_build_cycle_columns_before_1155 — deliberately a no-op.
--
-- 1154a only does, early, what 1396_build_sprint_cycle_chain_repair does later: rename
-- sprint_id -> cycle_id where needed, add build.cycles.legacy_sprint_id / goal / deleted_at, and
-- seed the build:sprints:* rows 1197 renames. On every database that ran 1396 the same objects
-- exist with or without 1154a, and 1155's indexes are built on them. Dropping or renaming them
-- here would break 1155 and 1396 rather than undo 1154a. Roll those back first (their own
-- rollback files) if the objects must go.

SELECT 1;
