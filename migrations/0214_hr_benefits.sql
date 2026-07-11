DO $$ BEGIN
  CREATE TYPE hr_benefit_category AS ENUM ('health','life','accident','retirement','wellness','perk','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_benefit_status AS ENUM ('draft','active','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_enrollment_status AS ENUM ('pending','active','waived','terminated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_enrollment_window_status AS ENUM ('upcoming','open','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_dependent_relationship AS ENUM ('spouse','child','parent','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_claim_status AS ENUM ('submitted','in_review','approved','rejected','paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_claim_payout_route AS ENUM ('payroll_payable','finance_payable','already_paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_loan_repayment_status AS ENUM ('pending','deducted','paid','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS hr_benefit_plans (
  id          SERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    hr_benefit_category NOT NULL,
  provider    TEXT,
  description TEXT,
  coverage    JSONB,
  premium_cents              INTEGER,
  employer_contribution_pct  INTEGER NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  status      hr_benefit_status NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_benefit_plans_org_name
  ON hr_benefit_plans (org_id, name);
CREATE INDEX IF NOT EXISTS idx_hr_benefit_plans_org_status
  ON hr_benefit_plans (org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_benefit_plans_org_category
  ON hr_benefit_plans (org_id, category);

CREATE TABLE IF NOT EXISTS hr_benefit_enrollment_windows (
  id         SERIAL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id    INTEGER REFERENCES hr_benefit_plans(id) ON DELETE CASCADE,
  opens_at   TIMESTAMP NOT NULL,
  closes_at  TIMESTAMP NOT NULL,
  status     hr_enrollment_window_status NOT NULL DEFAULT 'upcoming',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_enroll_windows_org_status
  ON hr_benefit_enrollment_windows (org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_enroll_windows_org_plan
  ON hr_benefit_enrollment_windows (org_id, plan_id);

CREATE TABLE IF NOT EXISTS hr_benefit_enrollments (
  id                SERIAL PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id           INTEGER NOT NULL REFERENCES hr_benefit_plans(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            hr_enrollment_status NOT NULL DEFAULT 'pending',
  enrolled_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  effective_from    DATE,
  dependents_covered INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_benefit_enrollments_org_plan_user
  ON hr_benefit_enrollments (org_id, plan_id, user_id);
CREATE INDEX IF NOT EXISTS idx_hr_benefit_enrollments_org_user
  ON hr_benefit_enrollments (org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_hr_benefit_enrollments_org_plan
  ON hr_benefit_enrollments (org_id, plan_id);

CREATE TABLE IF NOT EXISTS hr_dependents (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  relationship  hr_dependent_relationship NOT NULL,
  date_of_birth DATE,
  is_covered    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_dependents_org_user
  ON hr_dependents (org_id, user_id);

CREATE TABLE IF NOT EXISTS hr_insurance_claims (
  id               SERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id          INTEGER NOT NULL REFERENCES hr_benefit_plans(id) ON DELETE RESTRICT,
  claim_number     TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  status           hr_claim_status NOT NULL DEFAULT 'submitted',
  documents        JSONB,
  submitted_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  decided_at       TIMESTAMP,
  decided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  payout_route     hr_claim_payout_route,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_insurance_claims_org_number
  ON hr_insurance_claims (org_id, claim_number);
CREATE INDEX IF NOT EXISTS idx_hr_insurance_claims_org_user
  ON hr_insurance_claims (org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_hr_insurance_claims_org_status
  ON hr_insurance_claims (org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_insurance_claims_org_plan
  ON hr_insurance_claims (org_id, plan_id);

CREATE TABLE IF NOT EXISTS hr_loan_repayments (
  id               SERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  loan_id          INTEGER NOT NULL,
  installment_no   INTEGER NOT NULL,
  due_date         DATE NOT NULL,
  amount_cents     INTEGER NOT NULL,
  status           hr_loan_repayment_status NOT NULL DEFAULT 'pending',
  payroll_period_key TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_loan_repayments_loan_installment
  ON hr_loan_repayments (loan_id, installment_no);
CREATE INDEX IF NOT EXISTS idx_hr_loan_repayments_org_status
  ON hr_loan_repayments (org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_loan_repayments_org_due_date
  ON hr_loan_repayments (org_id, due_date);

CREATE TABLE IF NOT EXISTS hr_travel_visit_logs (
  id                 SERIAL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  travel_request_id  INTEGER NOT NULL,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visited_at         TIMESTAMP NOT NULL,
  location           TEXT NOT NULL,
  lat                TEXT,
  lng                TEXT,
  note               TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_travel_visit_logs_org_travel
  ON hr_travel_visit_logs (org_id, travel_request_id);
CREATE INDEX IF NOT EXISTS idx_hr_travel_visit_logs_org_user
  ON hr_travel_visit_logs (org_id, user_id);
