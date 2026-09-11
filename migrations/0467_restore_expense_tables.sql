-- Restore the two HR expense tables 0466 dropped by mistake.
--
-- 0466 retired the pre-rewrite accounting schema and swept `fin_expense_policies`
-- and `fin_reimbursement_batches` up with it. Neither belongs to accounting:
-- they are employee-expense tables owned by `modules/expenses` (HR self-service,
-- gated on `self:expenses` / `hr:expenses:*`), and they were only in the drop set
-- because they *referenced* the old ledger. Both held zero rows, so this is a
-- clean recreate with the two ledger references repointed at the new kernel:
--
--   journal_entry_id integer -> journal_entries    becomes  posted_journal_id text -> gl_journals
--   bank_account_id  integer -> fin_bank_accounts  becomes  cash_account_id   text -> gl_accounts
--
-- `fin_bank_accounts` has no successor table: a bank is now a `gl_accounts` row
-- with `is_cash = true`, and its sort-code/IBAN metadata lives on `bank_profiles`.
-- Pointing the batch at the cash GL account is the faithful translation.
--
-- The `fin_reimbursement_batch_status` enum went with the tables in 0466 step 3
-- and is recreated here.
--
-- Both tables are empty, so foreign keys and NOT NULLs are declared inline —
-- the ADD CONSTRAINT ... NOT VALID dance in backend/CLAUDE.md §3 exists for
-- constraining populated tables, and there is nothing to lock here.
--
-- Hand-authored for the same reason as 0464-0466: `migrations/meta` snapshots
-- stop at 0231 while migrations run to 0466, so `drizzle-kit generate` would
-- diff against a baseline ~230 migrations stale and propose recreating all of it.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fin_reimbursement_batch_status') THEN
    CREATE TYPE "public"."fin_reimbursement_batch_status" AS ENUM ('DRAFT', 'APPROVED', 'PAID');
  END IF;
END
$$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fin_reimbursement_batches" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "status" "public"."fin_reimbursement_batch_status" DEFAULT 'DRAFT' NOT NULL,
  "total_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
  "paid_date" date,
  "posted_journal_id" text REFERENCES "gl_journals"("id") ON DELETE SET NULL,
  "cash_account_id" text REFERENCES "gl_accounts"("id") ON DELETE SET NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "approved_by" text REFERENCES "users"("id"),
  "approved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_fin_reimbursement_batches_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fin_reimbursement_batches_org_status"
  ON "fin_reimbursement_batches" ("org_id", "status");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fin_expense_policies" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "category_id" integer REFERENCES "expense_categories"("id") ON DELETE SET NULL,
  "max_amount" numeric(12, 2),
  "requires_receipt_above" numeric(12, 2),
  "requires_approval_above" numeric(12, 2),
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_fin_expense_policies_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fin_expense_policies_org"
  ON "fin_expense_policies" ("org_id");
