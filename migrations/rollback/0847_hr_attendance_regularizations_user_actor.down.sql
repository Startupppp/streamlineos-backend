-- Rollback 0847: drop the hr_attendance_regularizations membership-id column.
--
-- @data-loss — the backfilled user_membership_id pointer is discarded. This is acceptable:
-- the legacy user_id column is still present and still populated, so the table returns to
-- a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- column will fail 42703 on the next read if the column is dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" DROP CONSTRAINT IF EXISTS "fk_hr_attendance_regularizations_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" DROP COLUMN IF EXISTS "user_membership_id";
