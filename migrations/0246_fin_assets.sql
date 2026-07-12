-- Migration 0246: Finance fixed assets and depreciation

DO $$ BEGIN
  CREATE TYPE acc_depreciation_method AS ENUM ('STRAIGHT_LINE', 'DECLINING_BALANCE', 'UNITS_OF_PRODUCTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE acc_asset_status AS ENUM ('DRAFT', 'ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE acc_depreciation_line_status AS ENUM ('SCHEDULED', 'POSTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE acc_depreciation_run_status AS ENUM ('DRAFT', 'POSTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS acc_asset_categories (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  asset_account_id integer NOT NULL REFERENCES ledger_accounts(id),
  depreciation_expense_account_id integer NOT NULL REFERENCES ledger_accounts(id),
  accumulated_depreciation_account_id integer NOT NULL REFERENCES ledger_accounts(id),
  default_method acc_depreciation_method NOT NULL DEFAULT 'STRAIGHT_LINE',
  default_useful_life_months integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_acc_asset_categories_org_name UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_acc_asset_categories_org ON acc_asset_categories (org_id);

CREATE TABLE IF NOT EXISTS acc_fixed_assets (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_number text NOT NULL,
  name text NOT NULL,
  category_id integer NOT NULL REFERENCES acc_asset_categories(id),
  acquisition_date date NOT NULL,
  acquisition_cost decimal(18,4) NOT NULL,
  salvage_value decimal(18,4) NOT NULL DEFAULT 0,
  useful_life_months integer NOT NULL,
  depreciation_method acc_depreciation_method NOT NULL DEFAULT 'STRAIGHT_LINE',
  vendor_id integer REFERENCES clients(id),
  bill_id integer REFERENCES purchase_bills(id),
  status acc_asset_status NOT NULL DEFAULT 'DRAFT',
  accumulated_depreciation decimal(18,4) NOT NULL DEFAULT 0,
  disposed_at timestamp,
  disposal_amount decimal(18,4),
  disposal_journal_entry_id integer REFERENCES journal_entries(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_acc_fixed_assets_org_number UNIQUE (org_id, asset_number)
);
CREATE INDEX IF NOT EXISTS idx_acc_fixed_assets_org_status ON acc_fixed_assets (org_id, status);
CREATE INDEX IF NOT EXISTS idx_acc_fixed_assets_org_category ON acc_fixed_assets (org_id, category_id);

CREATE TABLE IF NOT EXISTS acc_depreciation_runs (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  status acc_depreciation_run_status NOT NULL DEFAULT 'DRAFT',
  total_amount decimal(18,4) NOT NULL DEFAULT 0,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_by text NOT NULL REFERENCES users(id),
  posted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_acc_depreciation_runs_org_period UNIQUE (org_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_acc_depreciation_runs_org_status ON acc_depreciation_runs (org_id, status);

CREATE TABLE IF NOT EXISTS acc_depreciation_schedules (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id integer NOT NULL REFERENCES acc_fixed_assets(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  amount decimal(18,4) NOT NULL,
  run_id integer REFERENCES acc_depreciation_runs(id),
  journal_entry_id integer REFERENCES journal_entries(id),
  status acc_depreciation_line_status NOT NULL DEFAULT 'SCHEDULED',
  CONSTRAINT uniq_acc_depreciation_schedules_asset_period UNIQUE (asset_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_acc_depreciation_schedules_org_asset ON acc_depreciation_schedules (org_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_acc_depreciation_schedules_run ON acc_depreciation_schedules (run_id);
