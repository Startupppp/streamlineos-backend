-- Rollback 0905: drop the recognitions membership-id columns.
--
-- @data-loss — the backfilled from_membership_id and to_membership_id pointers are
-- discarded. This is acceptable: the legacy from_user_id and to_user_id columns are
-- still present and still populated, so the table returns to a working state.
--
-- Roll the code back first. Services cut over to dual-read the membership columns will
-- fail 42703 on the next read if the columns are dropped under a running deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "recognitions" DROP CONSTRAINT IF EXISTS "fk_recognitions_from_actor";

--> statement-breakpoint
ALTER TABLE "recognitions" DROP CONSTRAINT IF EXISTS "fk_recognitions_to_actor";

--> statement-breakpoint
ALTER TABLE "recognitions" DROP COLUMN IF EXISTS "from_membership_id";

--> statement-breakpoint
ALTER TABLE "recognitions" DROP COLUMN IF EXISTS "to_membership_id";
