SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.pm_workspace_memberships
  DROP CONSTRAINT IF EXISTS fk_pm_workspace_memberships_organization_membership_id_org;
--> statement-breakpoint
ALTER TABLE public.organization_people
  DROP CONSTRAINT IF EXISTS organization_people_organization_membership_id_fkey;
