-- PayrollOS Phase 1–2 foundation
-- Entities, periods, statutory rules, filings, jobs, allocations, TDS YTD, run types

DO $$ BEGIN CREATE TYPE payroll_entity_status AS ENUM ('ACTIVE','INACTIVE','ARCHIVED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE payroll_period_status AS ENUM ('OPEN','CUTOFF','LOCKED','CLOSED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE payroll_run_type AS ENUM ('REGULAR','BONUS','OFF_CYCLE','CORRECTION','FINAL_SETTLEMENT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE payroll_job_status AS ENUM ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS payroll_entities (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  country_code text NOT NULL DEFAULT 'IN',
  state_code text,
  base_currency text NOT NULL DEFAULT 'INR',
  pan text,
  tan text,
  pf_establishment_code text,
  esi_code text,
  pt_state_code text,
  status payroll_entity_status NOT NULL DEFAULT 'ACTIVE',
  metadata jsonb,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_entities_org_legal_name ON payroll_entities (org_id, legal_name);
CREATE INDEX IF NOT EXISTS idx_payroll_entities_org_status ON payroll_entities (org_id, status);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_id integer REFERENCES payroll_entities(id) ON DELETE SET NULL,
  period_key text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  cutoff_at timestamp,
  pay_date date,
  status payroll_period_status NOT NULL DEFAULT 'OPEN',
  working_days numeric(5,1),
  calendar_snapshot jsonb,
  locked_at timestamp,
  locked_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_periods_org_entity_key ON payroll_periods (org_id, entity_id, period_key);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_org_status ON payroll_periods (org_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_org_key ON payroll_periods (org_id, period_key);

CREATE TABLE IF NOT EXISTS payroll_statutory_rule_sets (
  id serial PRIMARY KEY,
  org_id text REFERENCES organizations(id) ON DELETE CASCADE,
  entity_id integer REFERENCES payroll_entities(id) ON DELETE SET NULL,
  country_code text NOT NULL DEFAULT 'IN',
  state_code text,
  rule_type text NOT NULL,
  version text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  config jsonb NOT NULL,
  source_ref text,
  is_system_default boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_stat_rules_lookup
  ON payroll_statutory_rule_sets (country_code, state_code, rule_type, effective_from);
CREATE INDEX IF NOT EXISTS idx_payroll_stat_rules_org
  ON payroll_statutory_rule_sets (org_id, rule_type);

CREATE TABLE IF NOT EXISTS payroll_filings (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_id integer REFERENCES payroll_entities(id) ON DELETE SET NULL,
  period_id integer REFERENCES payroll_periods(id) ON DELETE SET NULL,
  fiscal_year text,
  filing_type text NOT NULL,
  rule_version text,
  status text NOT NULL DEFAULT 'DRAFT',
  payload jsonb,
  artifact_key text,
  challan_ref text,
  acknowledgement_ref text,
  external_filing_required boolean NOT NULL DEFAULT true,
  status_label text DEFAULT 'Export prepared — external filing required',
  submitted_at timestamp,
  reconciled_at timestamp,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_filings_org_type ON payroll_filings (org_id, filing_type);
CREATE INDEX IF NOT EXISTS idx_payroll_filings_org_period ON payroll_filings (org_id, period_id);

CREATE TABLE IF NOT EXISTS payroll_jobs (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_id integer REFERENCES payroll_entities(id) ON DELETE SET NULL,
  job_type text NOT NULL,
  resource_type text,
  resource_id text,
  status payroll_job_status NOT NULL DEFAULT 'PENDING',
  progress integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  correlation_id text,
  idempotency_key text,
  error_message text,
  result jsonb,
  payload jsonb,
  started_at timestamp,
  finished_at timestamp,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_jobs_org_status ON payroll_jobs (org_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_jobs_correlation ON payroll_jobs (correlation_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_jobs_org_idem ON payroll_jobs (org_id, idempotency_key);

CREATE TABLE IF NOT EXISTS payroll_run_allocations (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id integer NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id text NOT NULL,
  amount numeric(15,2) NOT NULL,
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_run_allocations_source
  ON payroll_run_allocations (org_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_allocations_run
  ON payroll_run_allocations (org_id, run_id);

CREATE TABLE IF NOT EXISTS payroll_tds_ytd_ledger (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fiscal_year text NOT NULL,
  period_key text NOT NULL,
  run_id integer,
  taxable_income_paise integer NOT NULL DEFAULT 0,
  tds_paise integer NOT NULL DEFAULT 0,
  previous_employer_income_paise integer NOT NULL DEFAULT 0,
  previous_employer_tds_paise integer NOT NULL DEFAULT 0,
  perquisites_paise integer NOT NULL DEFAULT 0,
  surcharge_paise integer NOT NULL DEFAULT 0,
  rebate_paise integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_tds_ytd_user_period
  ON payroll_tds_ytd_ledger (org_id, user_id, fiscal_year, period_key);
CREATE INDEX IF NOT EXISTS idx_payroll_tds_ytd_user_fy
  ON payroll_tds_ytd_ledger (org_id, user_id, fiscal_year);

-- Extend payroll_runs for run types and versioning
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS run_type text NOT NULL DEFAULT 'REGULAR';
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS source_period_key text;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS source_run_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS entity_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS period_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS calculation_version text DEFAULT '1.0.0';
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS statutory_rule_version text;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS input_snapshot_hash text;

-- Replace unique(org, month) with unique(org, month, run_type) so off-cycle/correction can coexist
DROP INDEX IF EXISTS uniq_payroll_runs_org_month;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_runs_org_month_type
  ON payroll_runs (org_id, month, run_type);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_type ON payroll_runs (org_id, run_type);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_source_run ON payroll_runs (source_run_id);

-- Seed India system default statutory rule versions (FY 2025-26 / calendar 2026)
INSERT INTO payroll_statutory_rule_sets (
  org_id, country_code, state_code, rule_type, version, effective_from, effective_to, config, source_ref, is_system_default
)
SELECT NULL, 'IN', NULL, v.rule_type, v.version, v.effective_from::date, NULL, v.config::jsonb, v.source_ref, true
FROM (VALUES
  (
    'PF',
    'IN-PF-2025.04',
    '2025-04-01',
    '{"employeePercent":"12","employerPercent":"12","monthlyWageCeiling":"15000.00","wageCeilingFieldName":"monthlyWageCeiling","legacyMisnamedAnnualField":"21600","note":"EPF: 12% of min(basic, ₹15,000/mo). Legacy field annualWageCeiling:21600 was misnamed but equaled monthly ceiling × 12% max annual employee contribution."}',
    'EPFO EPF Scheme'
  ),
  (
    'ESI',
    'IN-ESI-2025.04',
    '2025-04-01',
    '{"employeePercent":"0.75","employerPercent":"3.25","monthlyEligibilityCeiling":"21000.00"}',
    'ESIC'
  ),
  (
    'PT',
    'IN-PT-DEFAULT-2025.04',
    '2025-04-01',
    '{"defaultMonthly":"200.00","stateAware":true,"note":"Override per state via org/entity rule rows"}',
    'State PT acts'
  ),
  (
    'LWF',
    'IN-LWF-DEFAULT-2025.04',
    '2025-04-01',
    '{"employeeFixed":"25.00","employerFixed":"25.00","stateAware":true}',
    'State LWF'
  ),
  (
    'GRATUITY',
    'IN-GRATUITY-2025.04',
    '2025-04-01',
    '{"provisionPercentOfBasic":"4.81","eligibilityYears":5,"wageBase":"last_drawn_basic_da"}',
    'Payment of Gratuity Act'
  ),
  (
    'TDS',
    'IN-TDS-NEW-2025.04',
    '2025-04-01',
    '{"regime":"NEW","formLabels":{"quarterlyReturn":"Form 24Q","annualCertificate":"Form 16"},"surchargeThresholds":true,"rebate87A":true,"ruleYearLabel":"FY 2025-26"}',
    'Income Tax Act'
  ),
  (
    'HRA',
    'IN-HRA-2025.04',
    '2025-04-01',
    '{"metroCities":["Mumbai","Delhi","Kolkata","Chennai"],"metroPercentOfBasic":"50","nonMetroPercentOfBasic":"40","exemptionMethod":"min_of_three"}',
    'Income Tax Act s.10(13A)'
  ),
  (
    'MIN_WAGE',
    'IN-MINWAGE-LABOUR-CODE',
    '2025-04-01',
    '{"basicDaMinPercentOfGross":"50","labourCodeWageDefinition":true,"note":"Labour Code: basic+DA should be at least 50% of wages"}',
    'Code on Wages'
  )
) AS v(rule_type, version, effective_from, config, source_ref)
WHERE NOT EXISTS (
  SELECT 1 FROM payroll_statutory_rule_sets s
  WHERE s.is_system_default AND s.rule_type = v.rule_type AND s.version = v.version
);
