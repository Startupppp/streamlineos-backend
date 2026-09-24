-- Rollback for migration 1118.
--
-- The forward migration dropped three single-column foreign keys that had
-- survived alongside the composite tenant keys added by 1098 and 1101.
-- Rolling back restores that duplicate state: each column will again carry two
-- constraints — the composite (left untouched by 1118) and the single-column
-- (restored here). This is intentional: the rollback must invert exactly what
-- 1118 did, no more.
--
-- The original FK definitions are NOT recorded in 1118 itself, and the dropped
-- constraints can no longer be read back from the database. The referenced
-- table and ON DELETE action for each column are taken from the schema source
-- of truth, src/db/schema/accounting/finance-expenses.ts, where the surviving
-- composite keys declare the same parent and the same SET NULL behaviour:
--
--   fin_reimbursement_batches_posted_journal_id_fkey
--     (posted_journal_id) REFERENCES gl_journals(id)       ON DELETE SET NULL
--   fin_reimbursement_batches_cash_account_id_fkey
--     (cash_account_id)   REFERENCES gl_accounts(id)       ON DELETE SET NULL
--   fin_expense_policies_category_id_fkey
--     (category_id)       REFERENCES expense_categories(id) ON DELETE SET NULL
--
-- Added NOT VALID + separate VALIDATE per backend/CLAUDE.md §3 to avoid holding
-- ACCESS EXCLUSIVE on both tables at once. statement_timeout = 0 because
-- VALIDATE CONSTRAINT performs a full table scan on a potentially populated DB.

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches"
  ADD CONSTRAINT "fin_reimbursement_batches_posted_journal_id_fkey"
  FOREIGN KEY ("posted_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches"
  VALIDATE CONSTRAINT "fin_reimbursement_batches_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches"
  ADD CONSTRAINT "fin_reimbursement_batches_cash_account_id_fkey"
  FOREIGN KEY ("cash_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches"
  VALIDATE CONSTRAINT "fin_reimbursement_batches_cash_account_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies"
  ADD CONSTRAINT "fin_expense_policies_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies"
  VALIDATE CONSTRAINT "fin_expense_policies_category_id_fkey";
