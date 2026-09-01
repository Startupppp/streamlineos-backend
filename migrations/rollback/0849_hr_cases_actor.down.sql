-- Rollback 0849: drop the hr_cases membership-id columns.
--
-- @data-loss — the backfilled assigned_to_membership_id and reported_by_membership_id
-- pointers are discarded. This is acceptable: the legacy assigned_to and reported_by
-- columns are still present and still populated, so the table returns to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_cases" DROP CONSTRAINT IF EXISTS "fk_hr_cases_assigned_to_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases" DROP CONSTRAINT IF EXISTS "fk_hr_cases_reported_by_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases" DROP COLUMN IF EXISTS "assigned_to_membership_id";

--> statement-breakpoint
ALTER TABLE "hr_cases" DROP COLUMN IF EXISTS "reported_by_membership_id";
