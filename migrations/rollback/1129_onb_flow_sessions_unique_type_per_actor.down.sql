-- Rollback for migration 1129.
--
-- Drops the two unique partial indexes on onboarding_flow_sessions. The
-- forward migration also abandoned duplicate sessions (set status =
-- 'abandoned') to satisfy the uniqueness precondition before the indexes were
-- created; those status changes are permanent — the original status of each
-- affected row was not captured and cannot be restored. Rolling back
-- re-permits duplicate non-abandoned sessions of the same type per actor;
-- any duplicates that form after the rollback will not be cleaned up
-- automatically.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_onb_flow_sessions_membership_type";
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_onb_flow_sessions_user_type";
