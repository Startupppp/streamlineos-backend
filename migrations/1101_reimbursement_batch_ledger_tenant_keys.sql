-- 1101 — fin_reimbursement_batches' two ledger pointers are tenant-scoped
-- =============================================================================
-- The other half of 1098. `check:tenant-relationships`, run in its pg_catalog
-- mode against a database bootstrapped to journal head, reports exactly two
-- actionable single-column tenant foreign keys in the whole catalogue:
--
--   fin_reimbursement_batches_cash_account_id_fkey
--     (cash_account_id) -> gl_accounts(id)        ON DELETE SET NULL
--   fin_reimbursement_batches_posted_journal_id_fkey
--     (posted_journal_id) -> gl_journals(id)      ON DELETE SET NULL
--
-- Both children and both parents carry `org_id`, so each key lets a row in
-- tenant A name a ledger object in tenant B and the database accepts it. That
-- is the whole of AR-02's subject, and the `uniq_gl_accounts_org_id` /
-- `uniq_gl_journals_org_id` unique constraints already exist on the parents,
-- which is what makes the composite expressible without any other change.
--
-- Why these two survived AR-02. The same way `fin_expense_policies.category_id`
-- did, and it is worth writing down once more because the filename prefixes
-- actively mislead here. 0466_drop_legacy_accounting (journal 853) dropped
-- `fin_reimbursement_batches` along with the pre-rewrite accounting schema, and
-- 0467_restore_expense_tables (journal 854) recreated it — faithfully, against
-- the definition it was written from, with both ledger pointers inline:
--
--   "posted_journal_id" text REFERENCES "gl_journals"("id")  ON DELETE SET NULL
--   "cash_account_id"   text REFERENCES "gl_accounts"("id")  ON DELETE SET NULL
--
-- The accounting-rewrite lane was interleaved into this journal by its own
-- `when` (1787679153441 / 1787682753441), which lands 0466/0467 at positions
-- 853-855 — AFTER the entire AR-02 series (0576, 0964, 0971). So the recreate is
-- the last word on this table and it reinstated precisely the shape AR-02 had
-- retired. 1098 repaired the sibling table, `fin_expense_policies`, and stopped
-- there; `fin_reimbursement_batches` is the same defect in the same migration
-- pair and is repaired here on the same terms.
--
-- The single-column keys are dropped rather than kept beside the composites.
-- They are not extra safety: satisfying (org_id, x) -> (org_id, id) implies
-- satisfying (x) -> (id), so the narrow key constrains nothing the composite
-- does not, and leaving it would put two keys nobody declares on one column —
-- which is how this drift class starts, and what `check:duplicate-foreign-keys`
-- measures on this very table.
--
-- SET NULL is kept, in PostgreSQL 15's column-list form — `SET NULL ("x")` — so
-- deleting a journal or a GL account clears the pointer and never `org_id`,
-- which is NOT NULL and would abort the delete instead. That is the form
-- `check:set-null-column-lists` and `check:composite-fk-set-null` require, and
-- it preserves the delete behaviour the single-column keys already had, so
-- nothing about deleting a ledger row changes.
--
-- Orphans. Both live single-column keys are validated, so every existing
-- `posted_journal_id` / `cash_account_id` already names a real parent row. The
-- only value a composite can reject is therefore one whose parent belongs to a
-- DIFFERENT tenant — the leak the composite exists to close. Such a value has
-- no legitimate reading, so the pre-check NULLs it: exactly what the
-- constraint's own ON DELETE SET NULL would have done had the parent been
-- deleted rather than merely being another tenant's, and both columns are
-- nullable with "not posted yet" / "no cash account recorded" as their meaning.
-- It raises a NOTICE with the count rather than failing, so the migration is not
-- blocked by the data it is designed to clean. Measured before writing this:
-- `fin_reimbursement_batches` holds 0 rows on this branch's cold database, so
-- the cleanup is a no-op here and exists for a populated one.
--
-- Every statement is idempotent: each ADD follows a DROP IF EXISTS, is added
-- NOT VALID and then validated, so a re-run is a no-op.

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DO $$
DECLARE
  cross_tenant bigint;
BEGIN
  UPDATE "public"."fin_reimbursement_batches" b
     SET "posted_journal_id" = NULL
   WHERE b."posted_journal_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "public"."gl_journals" j
        WHERE j."org_id" = b."org_id" AND j."id" = b."posted_journal_id"
     );
  GET DIAGNOSTICS cross_tenant = ROW_COUNT;
  IF cross_tenant > 0 THEN
    RAISE NOTICE '1101 cleared % fin_reimbursement_batches.posted_journal_id value(s) naming another tenant''s journal; the tenant key could not have accepted them', cross_tenant;
  END IF;

  UPDATE "public"."fin_reimbursement_batches" b
     SET "cash_account_id" = NULL
   WHERE b."cash_account_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "public"."gl_accounts" a
        WHERE a."org_id" = b."org_id" AND a."id" = b."cash_account_id"
     );
  GET DIAGNOSTICS cross_tenant = ROW_COUNT;
  IF cross_tenant > 0 THEN
    RAISE NOTICE '1101 cleared % fin_reimbursement_batches.cash_account_id value(s) naming another tenant''s GL account; the tenant key could not have accepted them', cross_tenant;
  END IF;
END $$;
--> statement-breakpoint

-- posted_journal_id -> gl_journals
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fin_reimbursement_batches_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fk_fin_reimbursement_batches_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_posted_journal_id_org"
  FOREIGN KEY ("org_id", "posted_journal_id") REFERENCES "public"."gl_journals"("org_id", "id") ON DELETE SET NULL ("posted_journal_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" VALIDATE CONSTRAINT "fk_fin_reimbursement_batches_posted_journal_id_org";
--> statement-breakpoint

-- cash_account_id -> gl_accounts
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fin_reimbursement_batches_cash_account_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" DROP CONSTRAINT IF EXISTS "fk_fin_reimbursement_batches_cash_account_id_org";
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_cash_account_id_org"
  FOREIGN KEY ("org_id", "cash_account_id") REFERENCES "public"."gl_accounts"("org_id", "id") ON DELETE SET NULL ("cash_account_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" VALIDATE CONSTRAINT "fk_fin_reimbursement_batches_cash_account_id_org";
