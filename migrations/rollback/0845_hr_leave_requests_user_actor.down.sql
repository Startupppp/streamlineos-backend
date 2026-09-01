-- Rollback 0845: drop the leave_requests membership-id columns.
--
-- @data-loss — the backfilled user_membership_id and covering_employee_membership_id
-- pointers are discarded. This is acceptable: the legacy user_id and covering_employee_id
-- columns are still present and still populated, so the table returns to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the column is dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "fk_leave_requests_user_actor";

--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "fk_leave_requests_covering_actor";

--> statement-breakpoint
ALTER TABLE "leave_requests" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "leave_requests" DROP COLUMN IF EXISTS "covering_employee_membership_id";
