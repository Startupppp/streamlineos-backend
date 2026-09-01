-- Rollback 0860: drop the reimbursements, salary_loans, bonuses, and fnf_settlements
-- membership-id columns.
--
-- @data-loss — the backfilled user_membership_id pointers are discarded. This is
-- acceptable: the legacy user_id columns are still present and still populated in all
-- four tables (they are financial record keys), so the tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "reimbursements" DROP CONSTRAINT IF EXISTS "fk_reimbursements_user_actor";

--> statement-breakpoint
ALTER TABLE "reimbursements" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "salary_loans" DROP CONSTRAINT IF EXISTS "fk_salary_loans_user_actor";

--> statement-breakpoint
ALTER TABLE "salary_loans" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "bonuses" DROP CONSTRAINT IF EXISTS "fk_bonuses_user_actor";

--> statement-breakpoint
ALTER TABLE "bonuses" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "fnf_settlements" DROP CONSTRAINT IF EXISTS "fk_fnf_settlements_user_actor";

--> statement-breakpoint
ALTER TABLE "fnf_settlements" DROP COLUMN IF EXISTS "user_membership_id";
