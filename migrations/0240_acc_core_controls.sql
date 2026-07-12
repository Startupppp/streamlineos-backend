-- Migration 0240: Accounting core control tables
DO $$ BEGIN
  CREATE TYPE acc_period_status AS ENUM ('OPEN', 'CLOSING', 'CLOSED', 'LOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE acc_basis AS ENUM ('ACCRUAL', 'CASH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE acc_system_purpose AS ENUM (
    'AR', 'AP', 'BANK_CLEARING', 'SALES_INCOME', 'DISCOUNT_GIVEN',
    'TAX_PAYABLE', 'TAX_RECEIVABLE', 'PAYROLL_PAYABLE', 'EXPENSE_CLEARING',
    'RETAINED_EARNINGS', 'OWNER_EQUITY', 'PAYMENT_FEES', 'REIMBURSEMENT_PAYABLE',
    'FX_GAIN_LOSS', 'DEPRECIATION_EXPENSE', 'ACCUM_DEPRECIATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_recur_frequency AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_approval_record_type AS ENUM (
    'MANUAL_JOURNAL', 'PURCHASE_BILL', 'VENDOR_PAYMENT', 'EXPENSE',
    'CREDIT_NOTE', 'PERIOD_REOPEN', 'BANK_ADJUSTMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_approval_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE acc_normal_balance AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS accounting_periods (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status acc_period_status NOT NULL DEFAULT 'OPEN',
  closed_by text REFERENCES users(id),
  closed_at timestamp,
  locked_by text REFERENCES users(id),
  locked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_accounting_periods_org_start UNIQUE (org_id, start_date)
);
CREATE INDEX IF NOT EXISTS idx_accounting_periods_org_status ON accounting_periods (org_id, status);

CREATE TABLE IF NOT EXISTS accounting_dimensions (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  key text NOT NULL,
  required_for_account_types jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_accounting_dimensions_org_key UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS accounting_dimension_values (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dimension_id integer NOT NULL REFERENCES accounting_dimensions(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_accounting_dim_values_org_dim_code UNIQUE (org_id, dimension_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounting_dim_values_org_dim ON accounting_dimension_values (org_id, dimension_id);

CREATE TABLE IF NOT EXISTS accounting_settings (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  base_currency text NOT NULL DEFAULT 'INR',
  fiscal_year_start_month integer NOT NULL DEFAULT 4,
  accounting_basis acc_basis NOT NULL DEFAULT 'ACCRUAL',
  tax_registration jsonb,
  coa_template text,
  setup_completed_at timestamp,
  retained_earnings_account_id integer REFERENCES ledger_accounts(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_accounting_settings_org UNIQUE (org_id)
);

CREATE TABLE IF NOT EXISTS acc_number_sequences (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  prefix text NOT NULL,
  next_number integer NOT NULL DEFAULT 1,
  padding integer NOT NULL DEFAULT 4,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_acc_number_sequences_org_entity UNIQUE (org_id, entity_type)
);

CREATE TABLE IF NOT EXISTS acc_system_account_map (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose acc_system_purpose NOT NULL,
  account_id integer NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_acc_system_account_map_org_purpose UNIQUE (org_id, purpose)
);
CREATE INDEX IF NOT EXISTS idx_acc_system_account_map_org ON acc_system_account_map (org_id);

CREATE TABLE IF NOT EXISTS fin_exchange_rates (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_currency text NOT NULL,
  to_currency text NOT NULL,
  rate decimal(18,8) NOT NULL,
  as_of_date date NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_fin_exchange_rates_org_pair_date UNIQUE (org_id, from_currency, to_currency, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_fin_exchange_rates_org_date ON fin_exchange_rates (org_id, as_of_date);

CREATE TABLE IF NOT EXISTS fin_approval_policies (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  record_type fin_approval_record_type NOT NULL,
  min_amount decimal(18,4),
  approver_role text,
  approver_user_id text REFERENCES users(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_approval_policies_org_type ON fin_approval_policies (org_id, record_type);

CREATE TABLE IF NOT EXISTS fin_approval_requests (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  record_type fin_approval_record_type NOT NULL,
  record_id integer NOT NULL,
  status fin_approval_status NOT NULL DEFAULT 'PENDING',
  requested_by text NOT NULL REFERENCES users(id),
  note text,
  decided_by text REFERENCES users(id),
  decided_at timestamp,
  decision_comment text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_approval_requests_org_status ON fin_approval_requests (org_id, status);
CREATE INDEX IF NOT EXISTS idx_fin_approval_requests_org_type_record ON fin_approval_requests (org_id, record_type, record_id);

CREATE TABLE IF NOT EXISTS fin_recurring_journal_templates (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  frequency fin_recur_frequency NOT NULL,
  next_run_date date,
  last_run_date date,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,
  lines jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_recurring_journal_templates_org ON fin_recurring_journal_templates (org_id);
