CREATE TABLE IF NOT EXISTS hr_probation_reviews (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employment_id INTEGER NOT NULL REFERENCES hr_employments(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES hr_people(id) ON DELETE CASCADE,
  probation_end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_probation' CHECK (status IN ('in_probation','review_due','extended','confirmed','terminated')),
  extension_count INTEGER NOT NULL DEFAULT 0,
  extended_until DATE,
  review_template_id INTEGER REFERENCES hr_templates(id) ON DELETE SET NULL,
  review_notes JSONB,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hr_probation_reviews_org ON hr_probation_reviews(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_probation_reviews_employment ON hr_probation_reviews(employment_id);
CREATE INDEX IF NOT EXISTS idx_hr_probation_reviews_status ON hr_probation_reviews(org_id, status);

ALTER TABLE alumni_profiles ADD COLUMN IF NOT EXISTS rehire_eligibility BOOLEAN NOT NULL DEFAULT TRUE;
