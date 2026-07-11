-- Migration 0223: HR Enterprise Compensation (Packs 1-5)
-- Idempotent — uses IF NOT EXISTS / CREATE TYPE … DO $$ … END $$

DO $$ BEGIN
  CREATE TYPE hr_time_device_type AS ENUM ('biometric','rfid','mobile','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_time_device_status AS ENUM ('active','inactive','faulty');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_device_sync_status AS ENUM ('success','failed','partial');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_variance_approval_status AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_arrears_status AS ENUM ('pending','applied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_compliance_task_status AS ENUM ('pending','completed','overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_comp_cycle_status AS ENUM ('draft','active','calibrating','approved','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_comp_recommendation_status AS ENUM ('draft','submitted','calibrated','approved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_equity_grant_type AS ENUM ('ISO','NSO','RSU','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_equity_grant_status AS ENUM ('active','exercised','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Pack 1: Time Clock Devices ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hr_time_devices (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  type          hr_time_device_type NOT NULL,
  location_id   INTEGER,
  status        hr_time_device_status NOT NULL DEFAULT 'active',
  last_sync_at  TIMESTAMPTZ,
  effective_from DATE,
  effective_to   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_time_devices_org_status
  ON hr_time_devices(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_time_devices_org_serial
  ON hr_time_devices(org_id, serial_number);

CREATE TABLE IF NOT EXISTS hr_device_sync_logs (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id     INTEGER NOT NULL REFERENCES hr_time_devices(id) ON DELETE CASCADE,
  status        hr_device_sync_status NOT NULL,
  records_count INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_device_sync_logs_org_device
  ON hr_device_sync_logs(org_id, device_id);
CREATE INDEX IF NOT EXISTS idx_hr_device_sync_logs_status
  ON hr_device_sync_logs(org_id, status);

CREATE TABLE IF NOT EXISTS hr_device_employee_mappings (
  id             SERIAL PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id      INTEGER NOT NULL REFERENCES hr_time_devices(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  biometric_id   TEXT,
  effective_from DATE,
  effective_to   DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_device_emp_mappings_org_device
  ON hr_device_employee_mappings(org_id, device_id);
CREATE INDEX IF NOT EXISTS idx_hr_device_emp_mappings_org_user
  ON hr_device_employee_mappings(org_id, user_id);

-- ── Pack 2: Advanced Payroll Compliance ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS hr_payroll_variance_approvals (
  id                 SERIAL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payroll_period_key TEXT NOT NULL,
  variance_pct       NUMERIC(8,4) NOT NULL,
  threshold_pct      NUMERIC(8,4) NOT NULL,
  status             hr_variance_approval_status NOT NULL DEFAULT 'pending',
  approver_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_variance_org_period
  ON hr_payroll_variance_approvals(org_id, payroll_period_key);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_variance_status
  ON hr_payroll_variance_approvals(org_id, status);

CREATE TABLE IF NOT EXISTS hr_arrears_adjustments (
  id             SERIAL PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason         TEXT NOT NULL,
  amount_cents   BIGINT NOT NULL,
  source_period  TEXT NOT NULL,
  target_period  TEXT NOT NULL,
  status         hr_arrears_status NOT NULL DEFAULT 'pending',
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_arrears_org_user
  ON hr_arrears_adjustments(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_hr_arrears_org_status
  ON hr_arrears_adjustments(org_id, status);

CREATE TABLE IF NOT EXISTS hr_payroll_compliance_tasks (
  id           SERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  name         TEXT NOT NULL,
  due_date     DATE NOT NULL,
  status       hr_compliance_task_status NOT NULL DEFAULT 'pending',
  notes        TEXT,
  completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_compliance_tasks_org_country
  ON hr_payroll_compliance_tasks(org_id, country_code);
CREATE INDEX IF NOT EXISTS idx_hr_compliance_tasks_org_status
  ON hr_payroll_compliance_tasks(org_id, status);

-- ── Pack 3: Compensation Planning ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hr_comp_cycles (
  id               SERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  fiscal_year      INTEGER NOT NULL,
  status           hr_comp_cycle_status NOT NULL DEFAULT 'draft',
  budget_pool_cents BIGINT NOT NULL,
  merit_matrix     JSONB,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_comp_cycles_org_status
  ON hr_comp_cycles(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_comp_cycles_org_year_name
  ON hr_comp_cycles(org_id, fiscal_year, name);

CREATE TABLE IF NOT EXISTS hr_comp_recommendations (
  id                       SERIAL PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cycle_id                 INTEGER NOT NULL REFERENCES hr_comp_cycles(id) ON DELETE CASCADE,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_salary_cents     BIGINT NOT NULL,
  recommended_increase_cents BIGINT NOT NULL,
  recommended_pct          NUMERIC(8,4) NOT NULL,
  rating                   TEXT,
  manager_note             TEXT,
  hr_calibrated_cents      BIGINT,
  status                   hr_comp_recommendation_status NOT NULL DEFAULT 'draft',
  submitted_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  calibrated_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_comp_recs_org_cycle
  ON hr_comp_recommendations(org_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_hr_comp_recs_org_user
  ON hr_comp_recommendations(org_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_comp_recs_cycle_user
  ON hr_comp_recommendations(cycle_id, user_id);

CREATE TABLE IF NOT EXISTS hr_comp_budget_pools (
  id              SERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cycle_id        INTEGER NOT NULL REFERENCES hr_comp_cycles(id) ON DELETE CASCADE,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  allocated_cents BIGINT NOT NULL,
  used_cents      BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_comp_budget_pools_org_cycle
  ON hr_comp_budget_pools(org_id, cycle_id);

-- ── Pack 4: Equity / ESOP ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hr_equity_grants (
  id                SERIAL PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_type        hr_equity_grant_type NOT NULL,
  units             INTEGER NOT NULL,
  strike_price_cents BIGINT,
  grant_date        DATE NOT NULL,
  cliff_months      INTEGER NOT NULL,
  vesting_months    INTEGER NOT NULL,
  status            hr_equity_grant_status NOT NULL DEFAULT 'active',
  board_approved_at TIMESTAMPTZ,
  document_url      TEXT,
  notes             TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_equity_grants_org_user
  ON hr_equity_grants(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_hr_equity_grants_org_status
  ON hr_equity_grants(org_id, status);

CREATE TABLE IF NOT EXISTS hr_equity_vesting_events (
  id               SERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id         INTEGER NOT NULL REFERENCES hr_equity_grants(id) ON DELETE CASCADE,
  vest_date        DATE NOT NULL,
  units_vested     INTEGER NOT NULL,
  cumulative_vested INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_equity_vesting_events_grant
  ON hr_equity_vesting_events(grant_id);
CREATE INDEX IF NOT EXISTS idx_hr_equity_vesting_events_org_grant
  ON hr_equity_vesting_events(org_id, grant_id);

CREATE TABLE IF NOT EXISTS hr_equity_exercises (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id      INTEGER NOT NULL REFERENCES hr_equity_grants(id) ON DELETE CASCADE,
  exercise_date DATE NOT NULL,
  units         INTEGER NOT NULL,
  amount_cents  BIGINT NOT NULL,
  notes         TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_equity_exercises_org_grant
  ON hr_equity_exercises(org_id, grant_id);
