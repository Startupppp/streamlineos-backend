-- Two partial unique indexes close the concurrent double-insert race in
-- getOrCreateSession.  The service does a read-then-insert; two concurrent
-- first-accesses can both miss the read and both attempt an insert, leaving two
-- sessions of the same type for the same actor.
--
-- The lookup predicate in sessionOwnerPredicate has two branches:
--   membership_id IS NOT NULL  -> keyed on (org_id, membership_id, type)
--   membership_id IS NULL      -> keyed on (org_id, user_id, type)
-- Each branch gets its own partial unique index so ON CONFLICT DO NOTHING
-- catches the race on both paths.
--
-- This table has no deleted_at column, so no soft-delete exclusion is needed.
-- The old plain index on (org_id, membership_id, type) is superseded by the
-- first partial unique index for the non-null path, and is dropped here.
--
-- Not CONCURRENTLY: db:migrate runs each file in a transaction.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_onb_flow_sessions_org_membership_type";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onb_flow_sessions_membership_type"
  ON "onboarding_flow_sessions" (org_id, membership_id, type)
  WHERE membership_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onb_flow_sessions_user_type"
  ON "onboarding_flow_sessions" (org_id, user_id, type)
  WHERE membership_id IS NULL;
