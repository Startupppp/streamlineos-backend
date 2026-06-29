-- Non-HR FK + index hardening (feat/nonhr-modules).
-- 1) Convert 8 org_id FKs from NO ACTION to ON DELETE CASCADE so org teardown
--    cascades like every sibling table (was blocking organization deletion).
-- 2) Add projects.deal_id -> deals(id) ON DELETE SET NULL (was an unconstrained
--    integer; column is wired into the "create project from deal" flow).
-- 3) Add missing indexes on self-referential parent columns + projects.deal_id.
-- Idempotent: safe to re-run (DROP IF EXISTS + guarded ADD, CREATE INDEX IF NOT EXISTS).

ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='branches_org_id_organizations_id_fk') THEN
    ALTER TABLE branches ADD CONSTRAINT branches_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS client_accounts_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='client_accounts_org_id_organizations_id_fk') THEN
    ALTER TABLE client_accounts ADD CONSTRAINT client_accounts_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE incentive_config DROP CONSTRAINT IF EXISTS incentive_config_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incentive_config_org_id_organizations_id_fk') THEN
    ALTER TABLE incentive_config ADD CONSTRAINT incentive_config_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE incentives DROP CONSTRAINT IF EXISTS incentives_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incentives_org_id_organizations_id_fk') THEN
    ALTER TABLE incentives ADD CONSTRAINT incentives_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE task_sequences DROP CONSTRAINT IF EXISTS task_sequences_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_sequences_org_id_organizations_id_fk') THEN
    ALTER TABLE task_sequences ADD CONSTRAINT task_sequences_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE territories DROP CONSTRAINT IF EXISTS territories_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='territories_org_id_organizations_id_fk') THEN
    ALTER TABLE territories ADD CONSTRAINT territories_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS custom_field_definitions_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='custom_field_definitions_org_id_organizations_id_fk') THEN
    ALTER TABLE custom_field_definitions ADD CONSTRAINT custom_field_definitions_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE web_lead_forms DROP CONSTRAINT IF EXISTS web_lead_forms_org_id_organizations_id_fk;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='web_lead_forms_org_id_organizations_id_fk') THEN
    ALTER TABLE web_lead_forms ADD CONSTRAINT web_lead_forms_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='projects_deal_id_deals_id_fk') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_deal_id_deals_id_fk
      FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
  END IF;
END $$;
-- @@SPLIT@@
CREATE INDEX IF NOT EXISTS idx_projects_deal ON projects(deal_id);
-- @@SPLIT@@
CREATE INDEX IF NOT EXISTS idx_targets_parent ON targets(parent_target_id);
-- @@SPLIT@@
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_page_id);
-- @@SPLIT@@
CREATE INDEX IF NOT EXISTS idx_okr_goals_parent ON okr_goals(parent_goal_id);
