-- Rollback 0863: drop the employee_salary_profiles and payslip_publications
-- membership-id columns.
--
-- @data-loss — the backfilled user_membership_id pointers are discarded. This is
-- acceptable: the legacy user_id columns are still present and still populated in both
-- tables (financial record keys), so the tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" DROP CONSTRAINT IF EXISTS "fk_employee_salary_profiles_user_actor";

--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "payslip_publications" DROP CONSTRAINT IF EXISTS "fk_payslip_publications_user_actor";

--> statement-breakpoint
ALTER TABLE "payslip_publications" DROP COLUMN IF EXISTS "user_membership_id";
