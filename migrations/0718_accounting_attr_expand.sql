SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE accounting_periods ADD COLUMN IF NOT EXISTS closed_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE accounting_periods ADD COLUMN IF NOT EXISTS locked_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE fin_bank_imports ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE fin_reconciliation_matches ADD COLUMN IF NOT EXISTS confirmed_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE fin_bank_transfers ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE fin_cash_flow_scenarios ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE fin_budgets ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE fin_budgets ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
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
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounting_periods_closed_by_membership') THEN
    ALTER TABLE accounting_periods
      ADD CONSTRAINT fk_accounting_periods_closed_by_membership
      FOREIGN KEY (org_id, closed_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounting_periods_locked_by_membership') THEN
    ALTER TABLE accounting_periods
      ADD CONSTRAINT fk_accounting_periods_locked_by_membership
      FOREIGN KEY (org_id, locked_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_imports_created_by_membership') THEN
    ALTER TABLE fin_bank_imports
      ADD CONSTRAINT fk_fin_bank_imports_created_by_membership
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_recon_matches_confirmed_by_membership') THEN
    ALTER TABLE fin_reconciliation_matches
      ADD CONSTRAINT fk_fin_recon_matches_confirmed_by_membership
      FOREIGN KEY (org_id, confirmed_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transfers_created_by_membership') THEN
    ALTER TABLE fin_bank_transfers
      ADD CONSTRAINT fk_fin_bank_transfers_created_by_membership
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_cash_flow_scenarios_created_by_membership') THEN
    ALTER TABLE fin_cash_flow_scenarios
      ADD CONSTRAINT fk_fin_cash_flow_scenarios_created_by_membership
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budgets_created_by_membership') THEN
    ALTER TABLE fin_budgets
      ADD CONSTRAINT fk_fin_budgets_created_by_membership
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budgets_approved_by_membership') THEN
    ALTER TABLE fin_budgets
      ADD CONSTRAINT fk_fin_budgets_approved_by_membership
      FOREIGN KEY (org_id, approved_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
