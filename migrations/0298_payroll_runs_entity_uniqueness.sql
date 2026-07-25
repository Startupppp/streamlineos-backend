-- Phase 10.3: allow one REGULAR (or run_type) per legal entity per org/month.
-- COALESCE(entity_id, 0) treats null-entity (org-level) runs as a single sentinel bucket
-- so multiple NULL entity_id rows cannot stack while still allowing entity A + entity B.

DROP INDEX IF EXISTS uniq_payroll_runs_org_month_type;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_runs_org_month_type_entity
  ON payroll_runs (org_id, month, run_type, (COALESCE(entity_id, 0)));

CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_entity
  ON payroll_runs (org_id, entity_id);
