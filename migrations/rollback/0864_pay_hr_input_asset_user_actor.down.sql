-- Rollback 0864: drop the hr_payroll_input_snapshots, hr_payroll_adjustments, and
-- asset_returns membership-id columns.
--
-- @data-loss — the backfilled user_membership_id pointers are discarded. This is
-- acceptable: the legacy user_id columns are still present and still populated in all
-- three tables, so the tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" DROP CONSTRAINT IF EXISTS "fk_hr_payroll_input_snapshots_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" DROP CONSTRAINT IF EXISTS "fk_hr_payroll_adjustments_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "asset_returns" DROP CONSTRAINT IF EXISTS "fk_asset_returns_user_actor";

--> statement-breakpoint
ALTER TABLE "asset_returns" DROP COLUMN IF EXISTS "user_membership_id";
