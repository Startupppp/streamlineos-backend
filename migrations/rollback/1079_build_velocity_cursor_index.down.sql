-- Rollback for 1079 — fully reversible, no data involved.
--
-- 1079 created one partial index on build.sprints to serve the velocity keyset
-- (org_id, project_id, start_date DESC, id DESC) WHERE deleted_at IS NULL AND status IN
-- ('ACTIVE', 'COMPLETED'). An index holds no data of its own, so dropping it loses nothing.
--
-- WHAT THIS COSTS. The velocity cursor falls back to whatever remains on build.sprints, so the
-- ordered read becomes a scan-and-sort of the project's sprints. Correctness is unaffected;
-- the query returns the same rows in the same order, more slowly.
--
-- Written 2026-09-09 alongside 1081. 1079 shipped without a rollback file and
-- check:migration-rollback had been failing on it since; this closes that gap rather than
-- declaring the migration irreversible, because a CREATE INDEX plainly is not.

SET lock_timeout = '5s';

DROP INDEX IF EXISTS build.idx_sprints_org_project_velocity_cursor;

RESET lock_timeout;
