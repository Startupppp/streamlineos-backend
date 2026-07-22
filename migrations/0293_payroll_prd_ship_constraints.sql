-- PayrollOS PRD ship: profile/component uniqueness and date integrity

-- One component assignment per profile (composite uniqueness)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_esp_components_profile_component
  ON employee_salary_profile_components (profile_id, component_id);

-- One profile per employee per effectiveFrom (revisions must change date)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_esp_org_user_effective_from
  ON employee_salary_profiles (org_id, user_id, effective_from);

-- Tax declaration uniqueness per user/FY (if table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'tax_declarations'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_declarations_org_user_fy
      ON tax_declarations (org_id, user_id, financial_year);
  END IF;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN undefined_table THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;
