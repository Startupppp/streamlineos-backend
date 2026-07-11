-- HR Governance migration: legal holds, retention, delegations, positions, labor relations
-- Idempotent — NOT applied automatically

DO $$ BEGIN
  CREATE TYPE hr_legal_hold_status AS ENUM ('active', 'released');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_legal_hold_item_type AS ENUM ('employee_profile', 'document', 'case_evidence');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_retention_record_type AS ENUM ('employee', 'document', 'case', 'attendance', 'payroll');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_retention_action AS ENUM ('delete', 'anonymize');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_data_request_type AS ENUM ('export', 'delete', 'anonymize');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_data_request_status AS ENUM ('pending', 'approved', 'processing', 'completed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_proxy_scope AS ENUM ('approvals', 'hr_admin', 'manager_tasks');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_position_status AS ENUM ('open', 'filled', 'frozen', 'future');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_reorg_scenario_status AS ENUM ('draft', 'proposed', 'applied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_union_membership_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_collective_agreement_status AS ENUM ('active', 'expired', 'negotiating');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_labor_case_status AS ENUM ('open', 'in_review', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Legal Holds

CREATE TABLE IF NOT EXISTS hr_legal_holds (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status hr_legal_hold_status NOT NULL DEFAULT 'active',
  placed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  released_at TIMESTAMPTZ,
  restricted_export BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_legal_holds_org_status ON hr_legal_holds(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_legal_holds_org_subject ON hr_legal_holds(org_id, subject_user_id);

CREATE TABLE IF NOT EXISTS hr_legal_hold_items (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hold_id INTEGER NOT NULL REFERENCES hr_legal_holds(id) ON DELETE CASCADE,
  item_type hr_legal_hold_item_type NOT NULL,
  item_ref TEXT NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_legal_hold_items_hold ON hr_legal_hold_items(hold_id);
CREATE INDEX IF NOT EXISTS idx_hr_legal_hold_items_org_subject ON hr_legal_hold_items(org_id, item_type, item_ref);

-- Retention Policies

CREATE TABLE IF NOT EXISTS hr_retention_policies (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  record_type hr_retention_record_type NOT NULL,
  retention_months INTEGER NOT NULL,
  country_code TEXT,
  action hr_retention_action NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_retention_policies_org ON hr_retention_policies(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_retention_policy_org_type_country ON hr_retention_policies(org_id, record_type, country_code);

-- Data Requests

CREATE TABLE IF NOT EXISTS hr_data_requests (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type hr_data_request_type NOT NULL,
  status hr_data_request_status NOT NULL DEFAULT 'pending',
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_data_requests_org_status ON hr_data_requests(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_data_requests_org_subject ON hr_data_requests(org_id, subject_user_id);

-- Proxy Access

CREATE TABLE IF NOT EXISTS hr_proxy_access (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grantor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proxy_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope hr_proxy_scope NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  disallow_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_proxy_access_org_grantor ON hr_proxy_access(org_id, grantor_user_id);
CREATE INDEX IF NOT EXISTS idx_hr_proxy_access_org_proxy ON hr_proxy_access(org_id, proxy_user_id);

-- Positions

CREATE TABLE IF NOT EXISTS hr_positions (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  job_level_id INTEGER,
  status hr_position_status NOT NULL DEFAULT 'open',
  budgeted_cost_cents INTEGER,
  effective_from TIMESTAMPTZ NOT NULL,
  incumbent_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  future_dated BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_positions_org_status ON hr_positions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_positions_org_dept ON hr_positions(org_id, department_id);
CREATE INDEX IF NOT EXISTS idx_hr_positions_org ON hr_positions(org_id);

-- Reorg Scenarios

CREATE TABLE IF NOT EXISTS hr_reorg_scenarios (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status hr_reorg_scenario_status NOT NULL DEFAULT 'draft',
  changes JSONB NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_reorg_scenarios_org_status ON hr_reorg_scenarios(org_id, status);

-- Union Memberships

CREATE TABLE IF NOT EXISTS hr_union_memberships (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  union_name TEXT NOT NULL,
  member_since TIMESTAMPTZ NOT NULL,
  status hr_union_membership_status NOT NULL DEFAULT 'active',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_union_memberships_org ON hr_union_memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_union_memberships_org_user ON hr_union_memberships(org_id, user_id);

-- Collective Agreements

CREATE TABLE IF NOT EXISTS hr_collective_agreements (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  union_name TEXT NOT NULL,
  title TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  document_url TEXT,
  status hr_collective_agreement_status NOT NULL DEFAULT 'active',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_collective_agreements_org_status ON hr_collective_agreements(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_collective_agreements_org_union ON hr_collective_agreements(org_id, union_name);

-- Labor Cases

CREATE TABLE IF NOT EXISTS hr_labor_cases (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  union_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status hr_labor_case_status NOT NULL DEFAULT 'open',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_labor_cases_org_status ON hr_labor_cases(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_labor_cases_org_union ON hr_labor_cases(org_id, union_name);
