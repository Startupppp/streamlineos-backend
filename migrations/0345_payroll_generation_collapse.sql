SET statement_timeout = 0;

-- =============================================================================
-- 0345 Payroll generation collapse
--
-- Collapses two generational duplications in the HR/payroll domain:
--
-- 1. payrolls (gen-1, flat per-user-per-month) is write-dead; all writes and
--    future reads go to payroll_runs + payroll_run_employees (gen-2).
--    The crm.incentives.payroll_id FK is dropped and the column removed.
--
-- 2. salary_structures (gen-1, flat per-user) is superseded by
--    employee_salary_profiles (gen-2) + employee_salary_profile_components.
--    The four flat columns (basic_salary, hra_percentage, allowances,
--    deductions) are added to employee_salary_profiles so the existing
--    API contract is preserved without requiring org-level component rows.
--
-- Database is empty on the primary branch; backfill blocks run as
-- conditional DO $$ ... $$ guards for non-empty environments.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add flat salary fields to employee_salary_profiles (gen-2 enrichment)
--    These map from salary_structures and preserve the hr:salary API contract.
-- ---------------------------------------------------------------------------
ALTER TABLE employee_salary_profiles
  ADD COLUMN IF NOT EXISTS basic_salary    NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS hra_percentage  NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS allowances      NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deductions      NUMERIC(15,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Backfill employee_salary_profiles from salary_structures
--    (no-op on empty DB; idempotent for existing environments)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_count FROM salary_structures;
  IF v_count = 0 THEN
    RETURN;
  END IF;

  UPDATE employee_salary_profiles esp
  SET
    basic_salary   = ss.basic_salary::numeric,
    hra_percentage = ss.hra_percentage::numeric,
    allowances     = ss.allowances::numeric,
    deductions     = ss.deductions::numeric
  FROM (
    SELECT DISTINCT ON (org_id, user_id)
      org_id, user_id,
      basic_salary, hra_percentage, allowances, deductions
    FROM salary_structures
    WHERE is_active = TRUE
    ORDER BY org_id, user_id, effective_from DESC
  ) ss
  WHERE esp.org_id  = ss.org_id
    AND esp.user_id = ss.user_id
    AND esp.status  = 'ACTIVE';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Backfill payroll_runs + payroll_run_employees from payrolls
--    (no-op on empty DB; idempotent for existing environments)
--
--    Shape mapping:
--      payrolls (org, month, status per-employee) →
--        one payroll_run per (org, month) with run_type='REGULAR',
--        run status = highest-priority employee status in that group;
--        one payroll_run_employees row per payrolls row.
--
--    Note: payrolls.status PENDING_APPROVAL maps to run status
--    PENDING_APPROVAL; gen-2 per-employee status (pre.status) is set to
--    'PENDING' uniformly since it tracks payment disbursement state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_count FROM payrolls;
  IF v_count = 0 THEN
    RETURN;
  END IF;

  INSERT INTO payroll_runs (
    org_id, month, run_type, status,
    gross_total, deduction_total, net_total, employee_count,
    created_at, updated_at
  )
  SELECT
    org_id,
    month,
    'REGULAR',
    (CASE
      WHEN bool_or(status::text = 'PAID')             THEN 'PAID'
      WHEN bool_or(status::text = 'APPROVED')         THEN 'APPROVED'
      WHEN bool_or(status::text = 'PENDING_APPROVAL') THEN 'PENDING_APPROVAL'
      ELSE 'DRAFT'
    END)::payroll_run_status,
    COALESCE(SUM(gross_salary::numeric), 0),
    COALESCE(SUM(deductions::numeric), 0),
    COALESCE(SUM(net_salary::numeric), 0),
    COUNT(*),
    MIN(created_at),
    NOW()
  FROM payrolls
  GROUP BY org_id, month
  ON CONFLICT DO NOTHING;

  INSERT INTO payroll_run_employees (
    org_id, run_id, user_id,
    gross, total_deductions, net,
    status,
    created_at, updated_at
  )
  SELECT
    p.org_id,
    pr.id,
    p.user_id,
    p.gross_salary::numeric,
    p.deductions::numeric,
    p.net_salary::numeric,
    'PENDING',
    p.created_at,
    NOW()
  FROM payrolls p
  JOIN payroll_runs pr
    ON  pr.org_id    = p.org_id
    AND pr.month     = p.month
    AND pr.run_type  = 'REGULAR'
  ON CONFLICT (run_id, user_id) DO NOTHING;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Drop the FK from incentives → payrolls, then drop the column
-- ---------------------------------------------------------------------------
ALTER TABLE incentives
  DROP CONSTRAINT IF EXISTS "incentives_payroll_id_payrolls_id_fk";

ALTER TABLE incentives
  DROP COLUMN IF EXISTS payroll_id;

-- ---------------------------------------------------------------------------
-- 5. Drop gen-1 tables (salary_structures before payrolls; no dependents on
--    salary_structures; payrolls has no remaining FKs after step 4)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS salary_structures;
DROP TABLE IF EXISTS payrolls;
