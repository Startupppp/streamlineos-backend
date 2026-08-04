-- 0395: Validate the RBAC tenant constraints installed by 0394.
-- Apply only after the preflight is clean and 0394 has been rehearsed on a clone/branch.
-- Each validation is an independent statement so operators can identify/retry one edge.

SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_assignments_org_role' AND NOT convalidated) THEN
    ALTER TABLE role_assignments VALIDATE CONSTRAINT fk_role_assignments_org_role;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_permission_grants_org_role' AND NOT convalidated) THEN
    ALTER TABLE role_permission_grants VALIDATE CONSTRAINT fk_role_permission_grants_org_role;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_principal_group_members_org_group' AND NOT convalidated) THEN
    ALTER TABLE principal_group_members VALIDATE CONSTRAINT fk_principal_group_members_org_group;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_group_role_assignments_org_group' AND NOT convalidated) THEN
    ALTER TABLE group_role_assignments VALIDATE CONSTRAINT fk_group_role_assignments_org_group;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_group_role_assignments_org_role' AND NOT convalidated) THEN
    ALTER TABLE group_role_assignments VALIDATE CONSTRAINT fk_group_role_assignments_org_role;
  END IF;
END $$;

