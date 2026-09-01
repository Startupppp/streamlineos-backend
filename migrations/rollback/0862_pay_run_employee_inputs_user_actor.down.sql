-- Rollback 0862: drop the payroll_run_employees and payroll_inputs membership-id columns.
--
-- @data-loss — the backfilled user_membership_id pointers are discarded. This is
-- acceptable: the legacy user_id columns are still present and still populated in both
-- tables (they are financial record keys), so the tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "payroll_run_employees" DROP CONSTRAINT IF EXISTS "fk_payroll_run_employees_user_actor";

--> statement-breakpoint
ALTER TABLE "payroll_run_employees" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "payroll_inputs" DROP CONSTRAINT IF EXISTS "fk_payroll_inputs_user_actor";

--> statement-breakpoint
ALTER TABLE "payroll_inputs" DROP COLUMN IF EXISTS "user_membership_id";
