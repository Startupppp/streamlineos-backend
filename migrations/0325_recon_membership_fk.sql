DO $g1$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='pm_workspace_memberships')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_pm_ws_members_org_membership') THEN
    ALTER TABLE pm_workspace_memberships ADD CONSTRAINT fk_pm_ws_members_org_membership
      FOREIGN KEY (org_id, organization_membership_id) REFERENCES organization_members(org_id, id) ON DELETE CASCADE;
  END IF;
END $g1$;
