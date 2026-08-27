-- Reconcile two tables whose baseline shape never caught up with the declared schema.
--
-- Both were created by the 0000 baseline and later renamed in db/schema/** with no migration, so
-- schema-catalog-parity failed on them: the Drizzle definition names columns the database does not
-- have. Neither holds a row, so this is a shape correction, not a data migration.
--
-- record_layout_adjustments: 0267 was meant to do this, but it opens with CREATE TABLE IF NOT
-- EXISTS and the baseline had already created an older shape -- so the create silently skipped and
-- the following ADD CONSTRAINT on org_id failed against a table that still had organization_id.
-- IF NOT EXISTS is the wrong guard when the risk is an incompatible existing table rather than a
-- repeated run. Dropping the empty stale table is safe and lets the declared shape stand.
--
-- fin_reimbursement_batches: posted_journal_id/cash_account_id were renamed to
-- journal_entry_id/bank_account_id in db/schema/accounting/finance-expenses.ts:17-18, and the type
-- changed text -> integer, so the backfill casts and copies only digit-only values.

SET lock_timeout = '30s';

--> statement-breakpoint
DROP TABLE IF EXISTS "record_layout_adjustments";

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_layout_adjustments" (
  "adjustment_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL,
  "layout_key" text NOT NULL,
  "field_order" text[] NOT NULL DEFAULT '{}'::text[],
  "hidden_fields" text[] NOT NULL DEFAULT '{}'::text[],
  "groups" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'record_layout_adjustments_org_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "record_layout_adjustments"
      ADD CONSTRAINT "record_layout_adjustments_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "record_layout_adjustments"
  VALIDATE CONSTRAINT "record_layout_adjustments_org_id_organizations_id_fk";

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniq_record_layout_adjustments_org_layout'
  ) THEN
    ALTER TABLE "record_layout_adjustments"
      ADD CONSTRAINT "uniq_record_layout_adjustments_org_layout" UNIQUE ("org_id", "layout_key");
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches"
  ADD COLUMN IF NOT EXISTS "journal_entry_id" integer;
--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches"
  ADD COLUMN IF NOT EXISTS "bank_account_id" integer;

--> statement-breakpoint
UPDATE "fin_reimbursement_batches"
SET "journal_entry_id" = "posted_journal_id"::integer
WHERE "posted_journal_id" ~ '^[0-9]+$' AND "journal_entry_id" IS NULL;
--> statement-breakpoint
UPDATE "fin_reimbursement_batches"
SET "bank_account_id" = "cash_account_id"::integer
WHERE "cash_account_id" ~ '^[0-9]+$' AND "bank_account_id" IS NULL;

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fin_reimbursement_batches_journal_entry_id_fk'
  ) THEN
    ALTER TABLE "fin_reimbursement_batches"
      ADD CONSTRAINT "fin_reimbursement_batches_journal_entry_id_fk"
      FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fin_reimbursement_batches_bank_account_id_fk'
  ) THEN
    ALTER TABLE "fin_reimbursement_batches"
      ADD CONSTRAINT "fin_reimbursement_batches_bank_account_id_fk"
      FOREIGN KEY ("bank_account_id") REFERENCES "fin_bank_accounts"("id") NOT VALID;
  END IF;
END $$;
