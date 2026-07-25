-- Point onboarding plan department targeting at org_departments (same list HR manages),
-- instead of the legacy integer departments table which is often empty/out of sync.

ALTER TABLE onboarding_templates
  DROP CONSTRAINT IF EXISTS onboarding_templates_department_id_departments_id_fk;

ALTER TABLE onboarding_templates
  ALTER COLUMN department_id DROP DEFAULT;

-- Existing integer IDs cannot map to org_departments UUIDs; clear them.
ALTER TABLE onboarding_templates
  ALTER COLUMN department_id TYPE text
  USING (NULL);

ALTER TABLE onboarding_templates
  ADD CONSTRAINT onboarding_templates_department_id_org_departments_id_fk
  FOREIGN KEY (department_id) REFERENCES org_departments(id) ON DELETE SET NULL;
