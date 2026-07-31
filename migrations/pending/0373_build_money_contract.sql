-- 0373 — Build money: CONTRACT phase. Drop the legacy `numeric` money columns.
--
-- ############################################################################
-- ## NOT APPLIED. This migration is authored, reviewed and reversible, but is ##
-- ## deliberately left unapplied (H1). Two code changes MUST land first.      ##
-- ############################################################################
--
-- 0370 was the EXPAND phase: it added integer minor-unit columns beside the
-- existing `numeric` ones and moved all arithmetic onto integers, while keeping
-- the legacy columns written so the change stayed reversible.
--
--   projects.budget              numeric(15,2)  ->  budget_minor bigint + budget_currency
--   project_members.hourly_rate  numeric(10,2)  ->  hourly_rate_minor bigint + rate_currency
--
-- PRECONDITIONS — verified by grep on 2026-07-31, re-verify before applying:
--
--   READS of the legacy columns: NONE. ProjectsBudgetService already reads
--   budget_minor / hourly_rate_minor exclusively. project_members.hourly_rate has
--   zero references outside the schema definition.
--
--   WRITES of the legacy columns: TWO remain, both deliberate dual-writes.
--     1. modules/build/core/projects-budget.service.ts:160   `budget: String(input.budget)`
--     2. modules/build/core/projects-provision.service.ts:167 `budget: deal.value ?? undefined`
--
--   CUTOVER STEP (do this, verify, deploy, THEN apply this migration):
--   remove those two dual-writes so nothing writes the legacy columns. Applying
--   this migration while they still execute produces a runtime error on every
--   project budget update and every project-created-from-deal.
--
-- The guard below fails loudly if any row would lose data, rather than dropping
-- a column whose value was never mirrored into minor units.

SET statement_timeout = 0;

--> statement-breakpoint
DO $$
DECLARE
  unmirrored_budgets integer;
  unmirrored_rates   integer;
BEGIN
  SELECT count(*) INTO unmirrored_budgets
  FROM projects
  WHERE budget IS NOT NULL AND budget <> 0 AND (budget_minor IS NULL OR budget_minor = 0);

  IF unmirrored_budgets > 0 THEN
    RAISE EXCEPTION
      'refusing to drop projects.budget - % row(s) have a budget that was never mirrored into budget_minor. Backfill first.',
      unmirrored_budgets;
  END IF;

  SELECT count(*) INTO unmirrored_rates
  FROM project_members
  WHERE hourly_rate IS NOT NULL AND hourly_rate <> 0 AND (hourly_rate_minor IS NULL OR hourly_rate_minor = 0);

  IF unmirrored_rates > 0 THEN
    RAISE EXCEPTION
      'refusing to drop project_members.hourly_rate - % row(s) have a rate that was never mirrored into hourly_rate_minor. Backfill first.',
      unmirrored_rates;
  END IF;

  RAISE NOTICE 'contract guard passed: 0 unmirrored budgets, 0 unmirrored rates';
END $$;

--> statement-breakpoint
ALTER TABLE "projects"        DROP COLUMN IF EXISTS "budget";
--> statement-breakpoint
ALTER TABLE "project_members" DROP COLUMN IF EXISTS "hourly_rate";
