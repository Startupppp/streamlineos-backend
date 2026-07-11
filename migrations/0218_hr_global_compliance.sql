DO $$ BEGIN
  CREATE TYPE hr_work_auth_type AS ENUM ('work_permit','visa','right_to_work','citizenship_proof','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_work_auth_status AS ENUM ('active','expiring','expired','pending_renewal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_compliance_category AS ENUM ('statutory_filing','registration','posting','training','audit','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_compliance_frequency AS ENUM ('once','monthly','quarterly','yearly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_compliance_event_status AS ENUM ('pending','done','overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_contract_type AS ENUM ('contractor','consultant','intern','temporary','agency','freelancer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_contract_status AS ENUM ('active','expiring','ended','renewed','converted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS hr_work_authorizations (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employment_id integer NOT NULL REFERENCES hr_employments(id) ON DELETE CASCADE,
  auth_type hr_work_auth_type NOT NULL,
  country_code text NOT NULL,
  document_number_masked text,
  valid_from date,
  valid_until date,
  status hr_work_auth_status NOT NULL DEFAULT 'active',
  verified_by text REFERENCES users(id) ON DELETE SET NULL,
  note text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp
);

CREATE INDEX IF NOT EXISTS idx_hr_work_auths_org_emp ON hr_work_authorizations(org_id, employment_id);
CREATE INDEX IF NOT EXISTS idx_hr_work_auths_org_valid_until ON hr_work_authorizations(org_id, valid_until);
CREATE INDEX IF NOT EXISTS idx_hr_work_auths_org_status ON hr_work_authorizations(org_id, status);

CREATE TABLE IF NOT EXISTS hr_compliance_requirements (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  country_code text,
  state_code text,
  category hr_compliance_category NOT NULL,
  frequency hr_compliance_frequency NOT NULL,
  due_rule jsonb NOT NULL DEFAULT '{}',
  reminder_days_before integer NOT NULL DEFAULT 7,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_compliance_req_org_name ON hr_compliance_requirements(org_id, name);
CREATE INDEX IF NOT EXISTS idx_hr_compliance_req_org_country ON hr_compliance_requirements(org_id, country_code);
CREATE INDEX IF NOT EXISTS idx_hr_compliance_req_org_active ON hr_compliance_requirements(org_id, active);

CREATE TABLE IF NOT EXISTS hr_compliance_events (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requirement_id integer NOT NULL REFERENCES hr_compliance_requirements(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  status hr_compliance_event_status NOT NULL DEFAULT 'pending',
  completed_by text REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamp,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_compliance_events_org_due ON hr_compliance_events(org_id, due_date);
CREATE INDEX IF NOT EXISTS idx_hr_compliance_events_org_status ON hr_compliance_events(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_compliance_events_req ON hr_compliance_events(requirement_id);

CREATE TABLE IF NOT EXISTS hr_contracts (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employment_id integer NOT NULL REFERENCES hr_employments(id) ON DELETE CASCADE,
  contract_type hr_contract_type NOT NULL,
  agency_vendor text,
  start_date date NOT NULL,
  end_date date,
  renewal_reminder_days integer NOT NULL DEFAULT 30,
  stipend_cents integer,
  timesheet_based boolean NOT NULL DEFAULT false,
  status hr_contract_status NOT NULL DEFAULT 'active',
  document_url text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp
);

CREATE INDEX IF NOT EXISTS idx_hr_contracts_org_end_date ON hr_contracts(org_id, end_date);
CREATE INDEX IF NOT EXISTS idx_hr_contracts_org_status ON hr_contracts(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_contracts_org_emp ON hr_contracts(org_id, employment_id);
