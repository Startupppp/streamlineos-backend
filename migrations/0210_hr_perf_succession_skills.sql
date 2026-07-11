-- HR Performance: template linkage + rating scale on review_cycles
ALTER TABLE review_cycles ADD COLUMN IF NOT EXISTS template_id integer REFERENCES hr_templates(id) ON DELETE SET NULL;
ALTER TABLE review_cycles ADD COLUMN IF NOT EXISTS template_version integer;
ALTER TABLE review_cycles ADD COLUMN IF NOT EXISTS rating_scale jsonb;

-- HR Performance: calibration entries
CREATE TABLE IF NOT EXISTS hr_calibration_entries (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cycle_id integer NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  employee_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pre_rating numeric(3,1),
  post_rating numeric(3,1),
  calibrated_by text REFERENCES users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calibration_entries_org ON hr_calibration_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_calibration_entries_cycle ON hr_calibration_entries(cycle_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calibration_cycle_employee ON hr_calibration_entries(cycle_id, employee_id);

-- HR Skills: role skill requirements
CREATE TABLE IF NOT EXISTS hr_role_skill_requirements (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_role_id integer REFERENCES hr_job_roles(id) ON DELETE CASCADE,
  role_name text,
  skill_name text NOT NULL,
  required_level integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_role_skill_req_org ON hr_role_skill_requirements(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_skill_req ON hr_role_skill_requirements(org_id, job_role_id, skill_name) WHERE job_role_id IS NOT NULL;

-- HR Learning: mentorships
CREATE TABLE IF NOT EXISTS hr_mentorships (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mentor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentee_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
  started_at date,
  ended_at date,
  goal text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mentorships_org ON hr_mentorships(org_id);
CREATE INDEX IF NOT EXISTS idx_mentorships_mentor ON hr_mentorships(mentor_id);
CREATE INDEX IF NOT EXISTS idx_mentorships_mentee ON hr_mentorships(mentee_id);

-- HR Succession
DO $$ BEGIN
  CREATE TYPE succession_readiness AS ENUM ('ready_now', '1_2_years', '3_plus');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS hr_succession_plans (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_name text NOT NULL,
  job_role_id integer REFERENCES hr_job_roles(id) ON DELETE SET NULL,
  incumbent_id text REFERENCES users(id) ON DELETE SET NULL,
  successor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  readiness succession_readiness NOT NULL DEFAULT 'ready_now',
  note text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_succession_org ON hr_succession_plans(org_id);
CREATE INDEX IF NOT EXISTS idx_succession_role ON hr_succession_plans(org_id, job_role_id);
