-- 1118 — Drop three single-column FKs that 1098 and 1101 were supposed to retire
-- =============================================================================
-- Migrations 1098 and 1101 each ran a DROP CONSTRAINT IF EXISTS before adding the
-- composite tenant key for that relationship. Both migrations were applied to this
-- database (their hashes are in drizzle.__drizzle_migrations) and both composite
-- keys are present, yet the single-column originals survived alongside them.
--
-- The result is that each of three relationships is enforced by two constraints:
--
--   fin_reimbursement_batches.cash_account_id
--     single-column:  fin_reimbursement_batches_cash_account_id_fkey   (from 0467)
--     composite:      fk_fin_reimbursement_batches_cash_account_id_org  (from 1101)
--
--   fin_reimbursement_batches.posted_journal_id
--     single-column:  fin_reimbursement_batches_posted_journal_id_fkey  (from 0467)
--     composite:      fk_fin_reimbursement_batches_posted_journal_id_org (from 1101)
--
--   fin_expense_policies.category_id
--     single-column:  fin_expense_policies_category_id_fkey             (from 0467)
--     composite:      fk_fin_expense_policies_category_id_org           (from 1098)
--
-- The root cause is recorded but not yet explained. The DROP statements in 1101 and
-- 1098 used IF EXISTS, so they could not fail; the composites are present; the
-- single-column keys survived. Regardless of cause, the symptom is two RI triggers
-- per INSERT/UPDATE on each of these columns — exactly the defect class
-- check:duplicate-foreign-keys and migration 1056 exist to prevent.
--
-- This migration closes the gap with the same DROP IF EXISTS pattern, which is a
-- no-op on any database where 1098/1101 correctly removed them, and a real fix on
-- any where they did not.

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint

ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fin_reimbursement_batches_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fin_reimbursement_batches_cash_account_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" DROP CONSTRAINT IF EXISTS "fin_expense_policies_category_id_fkey";
