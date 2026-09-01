-- Rollback 0904: drop the hr_proxy_access membership-id columns.
--
-- @data-loss — the backfilled grantor_membership_id and proxy_membership_id pointers are
-- discarded. This is acceptable: the legacy grantor_user_id and proxy_user_id columns are
-- still present and still populated, so the table returns to a working state.
--
-- Roll the code back first. Services cut over to dual-read the membership columns will
-- fail 42703 on the next read if the columns are dropped under a running deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" DROP CONSTRAINT IF EXISTS "fk_hr_proxy_access_grantor_actor";

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" DROP CONSTRAINT IF EXISTS "fk_hr_proxy_access_proxy_actor";

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" DROP COLUMN IF EXISTS "grantor_membership_id";

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" DROP COLUMN IF EXISTS "proxy_membership_id";
