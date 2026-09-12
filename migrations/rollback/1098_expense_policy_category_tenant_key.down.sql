-- Reverses 1098. Puts `fin_expense_policies.category_id` back on the
-- single-column `fin_expense_policies_category_id_fkey (category_id) ->
-- expense_categories(id) ON DELETE SET NULL` that 0467's recreate left, and
-- removes the tenant composite.
--
-- Read this before running it: the rollback restores a known tenant leak. With
-- only the narrow key in place, a policy in one organisation can name another
-- organisation's expense category and the database accepts the row, and any
-- 23503 handler naming `fk_fin_expense_policies_category_id_org` becomes
-- unreachable again.
--
-- The narrow key is a strict weakening of the composite — every row that
-- satisfied (org_id, category_id) -> (org_id, id) satisfies (category_id) ->
-- (id) — so it is added NOT VALID and then validated, which can never fail on
-- data 1098 left behind and reaches the same `convalidated` state 0467's inline
-- declaration had.
--
-- Not restored: the `category_id` values 1098 NULLed because they named another
-- tenant's category. They are gone, and re-deriving them would mean re-creating
-- the leak row by row. 1098 raises a NOTICE with the count when it clears any;
-- on every database measured at the time of writing that count was 0, because
-- `fin_expense_policies` held no rows anywhere.
--
-- Every ADD follows a DROP IF EXISTS, so a re-run is a no-op.
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" DROP CONSTRAINT IF EXISTS "fk_fin_expense_policies_category_id_org";
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" DROP CONSTRAINT IF EXISTS "fin_expense_policies_category_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."fin_expense_policies" VALIDATE CONSTRAINT "fin_expense_policies_category_id_fkey";
