-- Rollback 0903: drop the hr_disciplinary_actions employee_membership_id column.
--
-- @data-loss — the backfilled employee_membership_id pointer is discarded.
-- This is acceptable: the legacy employee_id column is still present and still populated,
-- so the table returns to a working state.
--
-- Roll the code back first. Services cut over to dual-read the membership column will
-- fail 42703 on the next read if the column is dropped under a running deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" DROP CONSTRAINT IF EXISTS "fk_hr_disciplinary_actions_employee_actor";

--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" DROP COLUMN IF EXISTS "employee_membership_id";
