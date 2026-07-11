-- Migration 0226: HR search indexes (pg_trgm GIN)
-- Idempotent — uses CREATE EXTENSION IF NOT EXISTS and CREATE INDEX IF NOT EXISTS

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- hr_people
CREATE INDEX IF NOT EXISTS idx_hr_people_first_name_trgm  ON hr_people USING GIN (first_name  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_people_last_name_trgm   ON hr_people USING GIN (last_name   gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_people_work_email_trgm  ON hr_people USING GIN (work_email  gin_trgm_ops);

-- hr_policies
CREATE INDEX IF NOT EXISTS idx_hr_policies_name_trgm        ON hr_policies USING GIN (name        gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_policies_description_trgm ON hr_policies USING GIN (description gin_trgm_ops);

-- hr_cases
CREATE INDEX IF NOT EXISTS idx_hr_cases_summary_trgm     ON hr_cases USING GIN (summary     gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_cases_case_number_trgm ON hr_cases USING GIN (case_number gin_trgm_ops);

-- hr_safety_incidents
CREATE INDEX IF NOT EXISTS idx_hr_safety_incidents_description_trgm     ON hr_safety_incidents USING GIN (description     gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_safety_incidents_incident_number_trgm ON hr_safety_incidents USING GIN (incident_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_safety_incidents_location_trgm        ON hr_safety_incidents USING GIN (location        gin_trgm_ops);

-- hr_automation_rules
CREATE INDEX IF NOT EXISTS idx_hr_automation_rules_name_trgm ON hr_automation_rules USING GIN (name gin_trgm_ops);
