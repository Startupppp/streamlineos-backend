DO $$ BEGIN
  CREATE TYPE hr_payroll_input_status AS ENUM ('open', 'building', 'built', 'locked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_payroll_input_section AS ENUM (
    'employee_master', 'compensation', 'attendance', 'leave',
    'overtime', 'reimbursement', 'deduction', 'lifecycle'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_payroll_adjustment_type AS ENUM ('arrears', 'recovery', 'correction');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_payroll_adjustment_status AS ENUM ('pending', 'approved', 'applied');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS hr_payroll_input_periods (
  id              serial PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_key      text NOT NULL,
  status          hr_payroll_input_status NOT NULL DEFAULT 'open',
  cutoff_date     date,
  built_at        timestamptz,
  locked_at       timestamptz,
  locked_by       text REFERENCES users(id) ON DELETE SET NULL,
  created_by      text REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE UNIQUE INDEX uniq_hr_payroll_input_periods_org_key
    ON hr_payroll_input_periods(org_id, period_key);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_hr_payroll_input_periods_org_status
  ON hr_payroll_input_periods(org_id, status);

CREATE TABLE IF NOT EXISTS hr_payroll_input_snapshots (
  id          serial PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id   integer NOT NULL REFERENCES hr_payroll_input_periods(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section     hr_payroll_input_section NOT NULL,
  payload     jsonb NOT NULL,
  source_refs jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE UNIQUE INDEX uniq_hr_payroll_input_snapshots_period_user_section
    ON hr_payroll_input_snapshots(period_id, user_id, section);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_hr_payroll_input_snapshots_org_period_user
  ON hr_payroll_input_snapshots(org_id, period_id, user_id);

CREATE TABLE IF NOT EXISTS hr_payroll_adjustments (
  id               serial PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id        integer REFERENCES hr_payroll_input_periods(id) ON DELETE SET NULL,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  adjustment_type  hr_payroll_adjustment_type NOT NULL,
  section          hr_payroll_input_section NOT NULL,
  amount_cents     bigint,
  days             numeric(8,2),
  reason           text NOT NULL,
  source_change_ref jsonb,
  status           hr_payroll_adjustment_status NOT NULL DEFAULT 'pending',
  created_by       text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by      text REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_adjustments_org_status
  ON hr_payroll_adjustments(org_id, status);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_adjustments_org_period
  ON hr_payroll_adjustments(org_id, period_id);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_adjustments_org_user
  ON hr_payroll_adjustments(org_id, user_id);
