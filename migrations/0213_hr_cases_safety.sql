-- Migration 0213: HR Cases, Disciplinary Actions, Safety Incidents, Wellness Check-ins
-- NOT applied automatically. Run in a TTY: pnpm -C backend db:migrate

DO $$ BEGIN
  CREATE TYPE hr_case_category AS ENUM (
    'grievance', 'disciplinary', 'harassment', 'ethics',
    'performance', 'workplace_conflict', 'policy_violation', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_case_severity AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_case_status AS ENUM (
    'open', 'under_investigation', 'resolved', 'closed', 'dismissed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_disciplinary_action_type AS ENUM (
    'verbal_warning', 'written_warning', 'final_warning',
    'suspension', 'termination_recommended'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_safety_incident_type AS ENUM (
    'injury', 'accident', 'near_miss', 'hazard', 'environmental', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_safety_incident_status AS ENUM (
    'open', 'investigating', 'mitigated', 'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hr_safety_incident_severity AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS hr_cases (
  id          SERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_number TEXT NOT NULL,
  category    hr_case_category NOT NULL,
  subject_employee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reported_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  anonymous           BOOLEAN NOT NULL DEFAULT FALSE,
  confidential        BOOLEAN NOT NULL DEFAULT TRUE,
  severity    hr_case_severity NOT NULL,
  status      hr_case_status NOT NULL DEFAULT 'open',
  summary     TEXT NOT NULL,
  details     TEXT NOT NULL,
  outcome     TEXT,
  resolved_at TIMESTAMPTZ,
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_cases_org_number ON hr_cases(org_id, case_number);
CREATE INDEX IF NOT EXISTS idx_hr_cases_org_status   ON hr_cases(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_cases_org_category ON hr_cases(org_id, category);
CREATE INDEX IF NOT EXISTS idx_hr_cases_org_assigned ON hr_cases(org_id, assigned_to);

CREATE TABLE IF NOT EXISTS hr_case_notes (
  id             SERIAL PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES hr_cases(id) ON DELETE CASCADE,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  note           TEXT NOT NULL,
  is_confidential BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_case_notes_case ON hr_case_notes(case_id);
CREATE INDEX IF NOT EXISTS idx_hr_case_notes_org  ON hr_case_notes(org_id);

CREATE TABLE IF NOT EXISTS hr_case_documents (
  id          SERIAL PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES hr_cases(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  restricted  BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_case_documents_case ON hr_case_documents(case_id);

CREATE TABLE IF NOT EXISTS hr_disciplinary_actions (
  id               SERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id          INTEGER REFERENCES hr_cases(id) ON DELETE SET NULL,
  employee_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_type      hr_disciplinary_action_type NOT NULL,
  letter_render_id INTEGER,
  effective_date   TIMESTAMPTZ NOT NULL,
  issued_by        TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_disciplinary_org_employee ON hr_disciplinary_actions(org_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_disciplinary_org_case     ON hr_disciplinary_actions(org_id, case_id);

CREATE TABLE IF NOT EXISTS hr_safety_incidents (
  id                       SERIAL PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_number          TEXT NOT NULL,
  type                     hr_safety_incident_type NOT NULL,
  location                 TEXT NOT NULL,
  occurred_at              TIMESTAMPTZ NOT NULL,
  reported_by              TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  description              TEXT NOT NULL,
  severity                 hr_safety_incident_severity NOT NULL,
  status                   hr_safety_incident_status NOT NULL DEFAULT 'open',
  medical_attention        BOOLEAN NOT NULL DEFAULT FALSE,
  confidential_medical_note TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_safety_incidents_org_number ON hr_safety_incidents(org_id, incident_number);
CREATE INDEX IF NOT EXISTS idx_hr_safety_incidents_org_status   ON hr_safety_incidents(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_safety_incidents_org_type     ON hr_safety_incidents(org_id, type);
CREATE INDEX IF NOT EXISTS idx_hr_safety_incidents_org_occurred ON hr_safety_incidents(org_id, occurred_at);

CREATE TABLE IF NOT EXISTS hr_wellness_checkins (
  id         SERIAL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  score      INTEGER NOT NULL,
  flags      JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_wellness_org_user_date ON hr_wellness_checkins(org_id, user_id, date);
CREATE INDEX IF NOT EXISTS idx_hr_wellness_org_date ON hr_wellness_checkins(org_id, date);
CREATE INDEX IF NOT EXISTS idx_hr_wellness_org_user ON hr_wellness_checkins(org_id, user_id);
