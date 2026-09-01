-- Rollback 0902: drop the wellness and mood checkin membership-id columns.
--
-- @data-loss — the backfilled user_membership_id pointers are discarded from both tables.
-- This is acceptable: the legacy user_id columns are still present and still populated,
-- so both tables return to a working state.
--
-- Roll the code back first. Services cut over to dual-read the membership columns will
-- fail 42703 on the next read if the column is dropped under a running deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins" DROP CONSTRAINT IF EXISTS "fk_hr_wellness_checkins_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_mood_checkins" DROP CONSTRAINT IF EXISTS "fk_hr_mood_checkins_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "hr_mood_checkins" DROP COLUMN IF EXISTS "user_membership_id";
