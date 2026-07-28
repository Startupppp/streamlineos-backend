SET statement_timeout = 0;
-- 0350 — Retire departments and department_members; repoint all consumers to org_units
--
-- Survivor: org_units (kind = 'DEPARTMENT') and org_unit_members.
-- The integer serial departments.id is replaced by the text UUID org_units.id
-- everywhere an FK pointed at departments.
--
-- DB is EMPTY for this deployment. UPDATE backfill blocks are no-ops and
-- are included so the migration is safe on a populated environment.
--
-- ON DELETE choices (per column):
--   hr_employments.department_id      → SET NULL: employment record is valid without a dept
--   hr_positions.department_id        → SET NULL: a position can be unfilled/cross-dept
--   documents.department_id           → SET NULL: document survives without its dept tag
--   hr_comp_budget_pools.department_id → SET NULL: budget pool is meaningful without dept
--   hr_headcount_plans.department_id  → SET NULL: plan survives; dept becomes "unassigned"
--   journal_lines.department_id       → SET NULL: line survives; just loses cost-centre tag
--   fin_budget_lines.department_id    → SET NULL: budget line survives without dept dimension
--
-- job_postings.department_id / headcount_requests.department_id are DROPPED ENTIRELY:
--   both already have org_department_id (text FK → org_units) as the survivor column.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 – Convert integer FK columns to text FK → org_units
-- ─────────────────────────────────────────────────────────────────────────────

-- 1-A. hr_employments.department_id
ALTER TABLE hr_employments
  DROP CONSTRAINT IF EXISTS hr_employments_department_id_departments_id_fk;
--> statement-breakpoint
ALTER TABLE hr_employments ADD COLUMN department_id_new text;
--> statement-breakpoint
UPDATE hr_employments SET department_id_new = NULL;
--> statement-breakpoint
ALTER TABLE hr_employments DROP COLUMN department_id;
--> statement-breakpoint
ALTER TABLE hr_employments RENAME COLUMN department_id_new TO department_id;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT fk_hr_employments_department
  FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-B. hr_positions.department_id
ALTER TABLE hr_positions
  DROP CONSTRAINT IF EXISTS hr_positions_department_id_departments_id_fk;
--> statement-breakpoint
ALTER TABLE hr_positions ADD COLUMN department_id_new text;
--> statement-breakpoint
UPDATE hr_positions SET department_id_new = NULL;
--> statement-breakpoint
ALTER TABLE hr_positions DROP COLUMN department_id;
--> statement-breakpoint
ALTER TABLE hr_positions RENAME COLUMN department_id_new TO department_id;
--> statement-breakpoint
ALTER TABLE hr_positions
  ADD CONSTRAINT fk_hr_positions_department
  FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-C. documents.department_id
ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_department_id_departments_id_fk;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN department_id_new text;
--> statement-breakpoint
UPDATE documents SET department_id_new = NULL;
--> statement-breakpoint
ALTER TABLE documents DROP COLUMN department_id;
--> statement-breakpoint
ALTER TABLE documents RENAME COLUMN department_id_new TO department_id;
--> statement-breakpoint
ALTER TABLE documents
  ADD CONSTRAINT fk_documents_department
  FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-D. hr_comp_budget_pools.department_id
ALTER TABLE hr_comp_budget_pools
  DROP CONSTRAINT IF EXISTS hr_comp_budget_pools_department_id_departments_id_fk;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools ADD COLUMN department_id_new text;
--> statement-breakpoint
UPDATE hr_comp_budget_pools SET department_id_new = NULL;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools DROP COLUMN department_id;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools RENAME COLUMN department_id_new TO department_id;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools
  ADD CONSTRAINT fk_hr_comp_budget_pools_department
  FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-E. hr_headcount_plans.department_id
--     uniq_hr_headcount_plans_org_year_dept includes department_id; drop before column
--     change, recreate on the new text column after rename.
ALTER TABLE hr_headcount_plans
  DROP CONSTRAINT IF EXISTS hr_headcount_plans_department_id_departments_id_fk;
--> statement-breakpoint
DROP INDEX IF EXISTS uniq_hr_headcount_plans_org_year_dept;
--> statement-breakpoint
ALTER TABLE hr_headcount_plans ADD COLUMN department_id_new text;
--> statement-breakpoint
UPDATE hr_headcount_plans SET department_id_new = NULL;
--> statement-breakpoint
ALTER TABLE hr_headcount_plans DROP COLUMN department_id;
--> statement-breakpoint
ALTER TABLE hr_headcount_plans RENAME COLUMN department_id_new TO department_id;
--> statement-breakpoint
CREATE UNIQUE INDEX uniq_hr_headcount_plans_org_year_dept
  ON hr_headcount_plans (org_id, fiscal_year, department_id);
--> statement-breakpoint
ALTER TABLE hr_headcount_plans
  ADD CONSTRAINT fk_hr_headcount_plans_department
  FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-F. journal_lines.department_id
ALTER TABLE journal_lines
  DROP CONSTRAINT IF EXISTS journal_lines_department_id_departments_id_fk;
--> statement-breakpoint
ALTER TABLE journal_lines ADD COLUMN department_id_new text;
--> statement-breakpoint
UPDATE journal_lines SET department_id_new = NULL;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN department_id;
--> statement-breakpoint
ALTER TABLE journal_lines RENAME COLUMN department_id_new TO department_id;
--> statement-breakpoint
ALTER TABLE journal_lines
  ADD CONSTRAINT fk_journal_lines_department
  FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-G. fin_budget_lines.department_id
--     uniq_fin_budget_lines_budget_acct_period includes department_id; same pattern.
ALTER TABLE fin_budget_lines
  DROP CONSTRAINT IF EXISTS fin_budget_lines_department_id_departments_id_fk;
--> statement-breakpoint
DROP INDEX IF EXISTS uniq_fin_budget_lines_budget_acct_period;
--> statement-breakpoint
ALTER TABLE fin_budget_lines ADD COLUMN department_id_new text;
--> statement-breakpoint
UPDATE fin_budget_lines SET department_id_new = NULL;
--> statement-breakpoint
ALTER TABLE fin_budget_lines DROP COLUMN department_id;
--> statement-breakpoint
ALTER TABLE fin_budget_lines RENAME COLUMN department_id_new TO department_id;
--> statement-breakpoint
CREATE UNIQUE INDEX uniq_fin_budget_lines_budget_acct_period
  ON fin_budget_lines (budget_id, account_id, period_key, department_id, project_id);
--> statement-breakpoint
ALTER TABLE fin_budget_lines
  ADD CONSTRAINT fk_fin_budget_lines_department
  FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 – Drop legacy department_id columns superseded by org_department_id
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE job_postings
  DROP CONSTRAINT IF EXISTS job_postings_department_id_departments_id_fk;
--> statement-breakpoint
ALTER TABLE job_postings DROP COLUMN IF EXISTS department_id;
--> statement-breakpoint

ALTER TABLE headcount_requests
  DROP CONSTRAINT IF EXISTS headcount_requests_department_id_departments_id_fk;
--> statement-breakpoint
ALTER TABLE headcount_requests DROP COLUMN IF EXISTS department_id;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 3 – Drop department_members (superseded by org_unit_members)
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS department_members CASCADE;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 4 – Drop departments (superseded by org_units kind = 'DEPARTMENT')
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS departments CASCADE;
