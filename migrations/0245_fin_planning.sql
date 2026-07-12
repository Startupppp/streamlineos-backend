-- Migration 0245: Finance budgeting and cash flow planning

DO $$ BEGIN
  CREATE TYPE fin_budget_period AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_budget_dimension AS ENUM ('NONE', 'DEPARTMENT', 'PROJECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_budget_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_scenario_kind AS ENUM ('CONSERVATIVE', 'EXPECTED', 'AGGRESSIVE', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fin_budgets (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  fiscal_year text NOT NULL,
  period_type fin_budget_period NOT NULL DEFAULT 'MONTHLY',
  dimension_type fin_budget_dimension DEFAULT 'NONE',
  status fin_budget_status NOT NULL DEFAULT 'DRAFT',
  total_amount decimal(18,4) NOT NULL DEFAULT 0,
  created_by text NOT NULL REFERENCES users(id),
  approved_by text REFERENCES users(id),
  approved_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_fin_budgets_org_name_year UNIQUE (org_id, name, fiscal_year)
);
CREATE INDEX IF NOT EXISTS idx_fin_budgets_org_status ON fin_budgets (org_id, status);

CREATE TABLE IF NOT EXISTS fin_budget_lines (
  id serial PRIMARY KEY,
  budget_id integer NOT NULL REFERENCES fin_budgets(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id integer NOT NULL REFERENCES ledger_accounts(id),
  department_id integer REFERENCES departments(id),
  project_id integer REFERENCES projects(id),
  period_key text NOT NULL,
  amount decimal(18,4) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_fin_budget_lines_budget_acct_period UNIQUE (budget_id, account_id, period_key, department_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_fin_budget_lines_org_budget ON fin_budget_lines (org_id, budget_id);

CREATE TABLE IF NOT EXISTS fin_budget_revisions (
  id serial PRIMARY KEY,
  budget_id integer NOT NULL REFERENCES fin_budgets(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  snapshot jsonb NOT NULL,
  note text,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_budget_revisions_budget ON fin_budget_revisions (budget_id);

CREATE TABLE IF NOT EXISTS fin_cash_flow_scenarios (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind fin_scenario_kind NOT NULL DEFAULT 'EXPECTED',
  assumptions jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_cash_flow_scenarios_org ON fin_cash_flow_scenarios (org_id);
