-- 1098 — fin_expense_policies' category key is tenant-scoped again
-- =============================================================================
-- `check:declaration-constraint-drift` reports four declared foreign keys that
-- do not exist at journal head. Exactly one of them is a missing object. This
-- is that one; the other three are stale declarations and are named below so a
-- reader does not go looking for them here.
--
-- What was wrong. `fin_expense_policies.category_id` is declared with ONE key,
-- the canonical tenant composite:
--
--   fk_fin_expense_policies_category_id_org
--     (org_id, category_id) -> expense_categories(org_id, id)  ON DELETE SET NULL
--                              (src/db/schema/accounting/finance-expenses.ts)
--
-- The catalogue has the opposite: no composite, and the single-column
-- `fin_expense_policies_category_id_fkey (category_id) -> expense_categories(id)`
-- that the AR-02 sweep had already retired. Both halves of AR-02 ran and both
-- were undone afterwards:
--
--   journal 652  0576_tenant_fks_public_a          adds the composite
--   journal 734  0964_ar02_canonical_tenant_fks_2  re-adds it canonically
--   journal 741  0971_ar02_drop_superseded_tenant_fks_2
--                                                  drops the single-column key
--   journal 853  0466_drop_legacy_accounting       drops fin_expense_policies
--   journal 854  0467_restore_expense_tables       recreates it, with
--                                                  `"category_id" integer
--                                                   REFERENCES "expense_categories"("id")
--                                                   ON DELETE SET NULL` inline
--
-- The filename prefixes read as if 0466/0467 came first. They do not. The
-- accounting-rewrite lane was interleaved into this journal by its own `when`
-- (1787679153441 / 1787682753441), which lands it at positions 853-855 — after
-- the whole AR-02 series. So the recreate is the last word, and it reinstates
-- precisely the key 0971 removed while losing the one 0964 installed. 0467 is
-- not wrong about anything it knew: it restored two tables 0466 had swept up by
-- mistake, faithfully, from the pre-AR-02 definition it was written against.
--
-- Why it matters. The single-column key does not name `org_id`, so a policy in
-- tenant A can point at tenant B's expense category and the database accepts
-- it. That is the whole point of the composite, and of the `uniq_*_org_id`
-- unique constraint on every parent that makes it expressible. It is also what
-- any 23503 handler naming `fk_fin_expense_policies_category_id_org` is waiting
-- for, and that name is currently unreachable.
--
-- The single-column key is dropped rather than kept beside the composite. It is
-- not extra safety: satisfying (org_id, category_id) -> (org_id, id) implies
-- satisfying (category_id) -> (id), so the narrow key constrains nothing the
-- composite does not, and leaving it would make one column carry two keys that
-- no declaration mentions — which is how this drift class starts. 0971 already
-- decided this; this migration is only re-applying that decision after the
-- recreate stepped on it.
--
-- SET NULL is kept, in Postgres 15's column-list form — `SET NULL ("category_id")`
-- — so deleting a category clears the pointer and never `org_id`, which is NOT
-- NULL and would abort the delete. That is the form `check:set-null-column-lists`
-- and `check:composite-fk-set-null` require, and it matches the action the
-- single-column key had, so delete behaviour is unchanged.
--
-- Orphans. The live single-column key is validated, so every existing
-- `category_id` already names a real `expense_categories.id`. The only row the
-- composite can reject is therefore one whose category belongs to a DIFFERENT
-- tenant — the leak the composite exists to close. Such a value has no
-- legitimate reading, so the pre-check NULLs it: that is exactly what the
-- constraint's own ON DELETE SET NULL would have done had the category been
-- deleted instead of merely being another tenant's, and `category_id` is
-- nullable with "no policy-specific category" as its meaning. It raises a
-- NOTICE with the count rather than failing, so the migration is not blocked by
-- data it is designed to clean. Measured before writing this: every local
-- database, this branch's included, holds 0 rows in `fin_expense_policies`, so
-- the cleanup is a no-op here and exists for a populated one.
--
-- ---------------------------------------------------------------------------
-- Deliberately NOT repaired here. The other three integrity findings are stale
-- DECLARATIONS, not missing objects, and a constraint that contradicts the
-- design is not a fix:
--
--   * expense_categories.fk_expense_categories_ledger_account_id_org and
--     expenses.fk_expenses_posted_journal_entry_id_org. Both are declared in
--     `src/db/schema/payroll/claims-and-settlements.ts` (fenced) against the
--     `accounting/accounting.ts` shim, which now aliases `glAccounts` /
--     `glJournals`. They are not creatable: `ledger_account_id` and
--     `posted_journal_entry_id` are `integer` (legacy serial ids) while
--     `gl_accounts.id` and `gl_journals.id` are `text`, and Postgres has no
--     equality operator across the pair. The runtime agrees the columns are
--     retired — `expenses.service.ts` ("kept for historical values and no
--     longer written"), `expense-approval.ts` ("no longer honoured … cannot
--     address a gl_accounts text id"), and `expense.schemas.ts` (the field is
--     stripped from the create DTO). The columns are kept on purpose; the two
--     declarations are what should go, in the payroll lane.
--
--   * notification_suppression_rules_user_id_users_id_fk, with the matching
--     `idx_notification_suppression_lookup` performance finding. 0918
--     (journal 698, the Common actor contract) dropped the users.id authority
--     key from this table on purpose — "Remove only users.id authority FKs.
--     The columns are retained for immutable display/delivery history, while
--     membership composite FKs provide tenant safety" — and re-keyed the
--     lookup index from (org_id, user_id, …) to (org_id, membership_id, …).
--     `fk_notification_suppression_rules_membership` and the re-keyed index
--     are both live. The declaration in
--     `src/db/schema/common/notifications-preferences.ts` still says `user_id`
--     and does not mention `membership_id` at all. Re-adding either object
--     would undo the cutover.
--
-- The seven remaining performance findings (`idx_inv_alloc_ovr_org_client`,
-- `..._org_created_id`, `..._org_lot`, `idx_inv_audit_org_created_id`,
-- `idx_inv_adj_org_reason`, `idx_inv_txn_org_created_id`, `idx_inv_txn_org_hu`)
-- are gate false positives and nothing is created for them. All seven exist,
-- with the declared columns, order and predicate — checked against pg_indexes,
-- not assumed. The gate's declared-side reader renders any index column it
-- cannot name as `<expr>` (declaration-constraint-drift/declared.ts), and a
-- Drizzle `desc(col)` is an SQL wrapper with no `.name`; the live side only
-- emits `<expr>` for a true expression column (`attnum = 0`). Every one of the
-- seven is declared with at least one `desc()`, so `created_at` on the live
-- side can never equal `<expr>` on the declared side. The fix is in the gate's
-- reader, not in the schema.
-- ---------------------------------------------------------------------------
--
-- Every statement is idempotent: the ADD follows a DROP IF EXISTS, is added
-- NOT VALID and then validated, so a re-run is a no-op.

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DO $$
DECLARE
  cross_tenant bigint;
BEGIN
  UPDATE "public"."fin_expense_policies" p
     SET "category_id" = NULL
   WHERE p."category_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "public"."expense_categories" c
        WHERE c."org_id" = p."org_id" AND c."id" = p."category_id"
     );
  GET DIAGNOSTICS cross_tenant = ROW_COUNT;
  IF cross_tenant > 0 THEN
    RAISE NOTICE '1098 cleared % fin_expense_policies.category_id value(s) naming another tenant''s expense category; the tenant key could not have accepted them', cross_tenant;
  END IF;
END $$;
--> statement-breakpoint

-- The single-column key 0971 retired and 0467's recreate reinstated. Dropped
-- before the composite is added so the column ends with exactly one key.
ALTER TABLE "public"."fin_expense_policies" DROP CONSTRAINT IF EXISTS "fin_expense_policies_category_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" DROP CONSTRAINT IF EXISTS "fk_fin_expense_policies_category_id_org";
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fk_fin_expense_policies_category_id_org"
  FOREIGN KEY ("org_id", "category_id") REFERENCES "public"."expense_categories"("org_id", "id") ON DELETE SET NULL ("category_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" VALIDATE CONSTRAINT "fk_fin_expense_policies_category_id_org";
