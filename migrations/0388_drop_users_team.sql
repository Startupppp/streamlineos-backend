SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0388 — drop the dead `users.team` column.
--
-- `users.team` was a legacy free-text label that later got dual-written with a
-- TEAM org-unit id. The dual-write was removed: `org_unit_members` joined to
-- `org_units` (kind = 'TEAM') is now the single source of truth. `updateUser`
-- and `bulkUpdateUsers` no longer write the column, `listUsers` filters through
-- an EXISTS over the normalized tables, and `getUser` resolves `team` via a
-- correlated subquery that is aliased `team` but does not read this column.
--
-- Verified before dropping: zero symbol references to `users.team` in the
-- backend, zero raw-SQL references, and no FK depends on it.
--
-- DROP COLUMN takes ACCESS EXCLUSIVE on `users`, but it is a catalog-only
-- operation (Postgres marks the attribute dropped rather than rewriting the
-- table), so it is fast. `lock_timeout` is set so it fails fast instead of
-- queueing behind a long-running reader and blocking every writer behind it.

ALTER TABLE "users" DROP COLUMN IF EXISTS "team";
