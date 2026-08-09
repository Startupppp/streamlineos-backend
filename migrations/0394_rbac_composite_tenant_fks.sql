-- 0394: Enforce tenant ownership on RBAC role/group edges for all new writes.
-- Run the read-only docs/schema-migration/rbac-composite-fk-preflight.sql first.
-- NOT VALID deliberately avoids scanning existing rows while the constraint is added.
-- Existing rows are validated separately by 0395 after the production-branch rehearsal.

SET statement_timeout = 0;
SET lock_timeout = '5s';

-- Composite tenant foreign keys require an exact unique key on the parent.
-- The Drizzle schema already declares this index, but the original
-- principal-groups migration predated that declaration.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_principal_groups_org_id"
  ON "principal_groups" ("org_id", "id");
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'role_assignments'::regclass AND c.contype = 'f'
      AND replace(pg_get_constraintdef(c.oid), '"', '') LIKE
        'FOREIGN KEY (org_id, role_id) REFERENCES roles(org_id, id)%'
  ) THEN
    ALTER TABLE role_assignments
      ADD CONSTRAINT fk_role_assignments_org_role
      FOREIGN KEY (org_id, role_id) REFERENCES roles(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'role_permission_grants'::regclass AND c.contype = 'f'
      AND replace(pg_get_constraintdef(c.oid), '"', '') LIKE
        'FOREIGN KEY (org_id, role_id) REFERENCES roles(org_id, id)%'
  ) THEN
    ALTER TABLE role_permission_grants
      ADD CONSTRAINT fk_role_permission_grants_org_role
      FOREIGN KEY (org_id, role_id) REFERENCES roles(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'principal_group_members'::regclass AND c.contype = 'f'
      AND replace(pg_get_constraintdef(c.oid), '"', '') LIKE
        'FOREIGN KEY (org_id, principal_group_id) REFERENCES principal_groups(org_id, id)%'
  ) THEN
    ALTER TABLE principal_group_members
      ADD CONSTRAINT fk_principal_group_members_org_group
      FOREIGN KEY (org_id, principal_group_id) REFERENCES principal_groups(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'group_role_assignments'::regclass AND c.contype = 'f'
      AND replace(pg_get_constraintdef(c.oid), '"', '') LIKE
        'FOREIGN KEY (org_id, principal_group_id) REFERENCES principal_groups(org_id, id)%'
  ) THEN
    ALTER TABLE group_role_assignments
      ADD CONSTRAINT fk_group_role_assignments_org_group
      FOREIGN KEY (org_id, principal_group_id) REFERENCES principal_groups(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'group_role_assignments'::regclass AND c.contype = 'f'
      AND replace(pg_get_constraintdef(c.oid), '"', '') LIKE
        'FOREIGN KEY (org_id, role_id) REFERENCES roles(org_id, id)%'
  ) THEN
    ALTER TABLE group_role_assignments
      ADD CONSTRAINT fk_group_role_assignments_org_role
      FOREIGN KEY (org_id, role_id) REFERENCES roles(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
