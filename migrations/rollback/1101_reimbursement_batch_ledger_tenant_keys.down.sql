-- Reverses 1101. Puts `fin_reimbursement_batches`' two ledger pointers back on
-- the single-column keys 0467's recreate left —
--   fin_reimbursement_batches_posted_journal_id_fkey (posted_journal_id) -> gl_journals(id)  ON DELETE SET NULL
--   fin_reimbursement_batches_cash_account_id_fkey   (cash_account_id)   -> gl_accounts(id)  ON DELETE SET NULL
-- — and removes the two tenant composites. The exact counterpart of the 1098
-- rollback, because 1101 is the other half of 1098.
--
-- Read this before running it: the rollback restores a known tenant leak, twice
-- over. With only the narrow keys in place, a reimbursement batch in one
-- organisation can name another organisation's GL journal or cash account and
-- the database accepts the row, and any 23503 handler naming
-- `fk_fin_reimbursement_batches_posted_journal_id_org` or
-- `fk_fin_reimbursement_batches_cash_account_id_org` becomes unreachable again.
--
-- Each narrow key is a strict weakening of its composite — every row satisfying
-- (org_id, x) -> (org_id, id) satisfies (x) -> (id) — so each is added NOT VALID
-- and then validated, which can never fail on data 1101 left behind and reaches
-- the same `convalidated` state 0467's inline declaration had.
--
-- ON DELETE SET NULL loses its column list here, and that is correct rather than
-- sloppy: on a SINGLE-column key the bare form nulls that one column and there is
-- no tenant column in the key to damage. The column-list form exists precisely
-- because the composite spans `org_id`; going back to the narrow key removes the
-- reason for it. Delete behaviour is unchanged either way, which is what 1101
-- says it preserved.
--
-- Not restored: the `posted_journal_id` and `cash_account_id` values 1101 NULLed
-- because they named another tenant's ledger row. They are gone, and re-deriving
-- them would mean re-creating the leak row by row. 1101 raises a NOTICE with the
-- count when it clears any; on this branch's cold database
-- `fin_reimbursement_batches` holds 0 rows, so on every database measured at the
-- time of writing that count was 0.
--
-- Every ADD follows a DROP IF EXISTS, so a re-run is a no-op.
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint

-- posted_journal_id -> gl_journals
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fk_fin_reimbursement_batches_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fin_reimbursement_batches_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_posted_journal_id_fkey"
  FOREIGN KEY ("posted_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" VALIDATE CONSTRAINT "fin_reimbursement_batches_posted_journal_id_fkey";
--> statement-breakpoint

-- cash_account_id -> gl_accounts
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fk_fin_reimbursement_batches_cash_account_id_org";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fin_reimbursement_batches_cash_account_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_cash_account_id_fkey"
  FOREIGN KEY ("cash_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" VALIDATE CONSTRAINT "fin_reimbursement_batches_cash_account_id_fkey";
