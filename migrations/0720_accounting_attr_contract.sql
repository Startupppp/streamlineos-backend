SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE accounting_periods t
SET closed_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.closed_by
  AND t.closed_by IS NOT NULL
  AND t.closed_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE accounting_periods t
SET locked_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.locked_by
  AND t.locked_by IS NOT NULL
  AND t.locked_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE fin_bank_imports t
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.created_by
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE fin_reconciliation_matches t
SET confirmed_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.confirmed_by
  AND t.confirmed_by IS NOT NULL
  AND t.confirmed_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE fin_bank_transfers t
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.created_by
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE fin_cash_flow_scenarios t
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.created_by
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE fin_budgets t
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.created_by
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE fin_budgets t
SET approved_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.approved_by
  AND t.approved_by IS NOT NULL
  AND t.approved_by_membership_id IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  unmapped bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM accounting_periods WHERE closed_by IS NOT NULL AND closed_by_membership_id IS NULL)
  + (SELECT count(*) FROM accounting_periods WHERE locked_by IS NOT NULL AND locked_by_membership_id IS NULL)
  + (SELECT count(*) FROM fin_bank_imports WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL)
  + (SELECT count(*) FROM fin_reconciliation_matches WHERE confirmed_by IS NOT NULL AND confirmed_by_membership_id IS NULL)
  + (SELECT count(*) FROM fin_bank_transfers WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL)
  + (SELECT count(*) FROM fin_cash_flow_scenarios WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL)
  + (SELECT count(*) FROM fin_budgets WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL)
  + (SELECT count(*) FROM fin_budgets WHERE approved_by IS NOT NULL AND approved_by_membership_id IS NULL)
  INTO unmapped;
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'refusing to drop legacy actor columns: % row(s) still carry a legacy actor with no membership counterpart', unmapped;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "accounting_periods" DROP COLUMN IF EXISTS "closed_by";
--> statement-breakpoint
ALTER TABLE "accounting_periods" DROP COLUMN IF EXISTS "locked_by";
--> statement-breakpoint
ALTER TABLE "fin_bank_imports" DROP COLUMN IF EXISTS "created_by";
--> statement-breakpoint
ALTER TABLE "fin_reconciliation_matches" DROP COLUMN IF EXISTS "confirmed_by";
--> statement-breakpoint
ALTER TABLE "fin_bank_transfers" DROP COLUMN IF EXISTS "created_by";
--> statement-breakpoint
ALTER TABLE "fin_cash_flow_scenarios" DROP COLUMN IF EXISTS "created_by";
--> statement-breakpoint
ALTER TABLE "fin_budgets" DROP COLUMN IF EXISTS "created_by";
--> statement-breakpoint
ALTER TABLE "fin_budgets" DROP COLUMN IF EXISTS "approved_by";
