SET statement_timeout = 0;

-- Collapse the 25-role zoo to the six structural roles.
-- organization_members.role may now only hold: OWNER | ORG_ADMIN | MEMBER.
-- CEO / HR / SALES / ENGINEERING etc. become user-created module role groups, not system roles.

-- 1. Normalise organization_members.role to the three org-level structural values.
UPDATE "organization_members" SET "role" = 'OWNER'
  WHERE "is_owner" = true;
--> statement-breakpoint

UPDATE "organization_members" SET "role" = 'ORG_ADMIN'
  WHERE "is_owner" = false AND upper("role") IN ('ADMIN', 'ORG_ADMIN', 'CEO');
--> statement-breakpoint

UPDATE "organization_members" SET "role" = 'MEMBER'
  WHERE "is_owner" = false AND "role" NOT IN ('ORG_ADMIN', 'MEMBER');
--> statement-breakpoint

-- 2. Normalise pending invitations to the same set.
UPDATE "invitations" SET "role" = 'ORG_ADMIN'
  WHERE upper("role") IN ('ADMIN', 'ORG_ADMIN', 'CEO') AND "status" = 'PENDING';
--> statement-breakpoint

UPDATE "invitations" SET "role" = 'MEMBER'
  WHERE "role" NOT IN ('ORG_ADMIN', 'MEMBER') AND "status" = 'PENDING';
--> statement-breakpoint

-- 3. Drop the retired system roles — but ONLY if nothing depends on them.
--    Deleting a role cascades to role_permission_grants and role_assignments, so an assigned
--    legacy role must abort the migration loudly rather than silently stripping someone's access.
DO $$
DECLARE
  assigned_count integer;
  offending text;
BEGIN
  SELECT count(*), COALESCE(string_agg(DISTINCT r.slug, ', '), '')
    INTO assigned_count, offending
  FROM "role_assignments" a
  JOIN "roles" r ON r.id = a.role_id
  WHERE r.module_key IS NULL
    AND r.is_system = true
    AND r.slug NOT IN ('OWNER', 'ORG_ADMIN', 'MEMBER');

  IF assigned_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop legacy roles: % assignment(s) still reference them (%). Reassign those members to module role groups first.',
      assigned_count, offending;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  group_count integer;
BEGIN
  SELECT count(*) INTO group_count
  FROM "group_role_assignments" g
  JOIN "roles" r ON r.id = g.role_id
  WHERE r.module_key IS NULL
    AND r.is_system = true
    AND r.slug NOT IN ('OWNER', 'ORG_ADMIN', 'MEMBER');

  IF group_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop legacy roles: % group assignment(s) still reference them.', group_count;
  END IF;
END $$;
--> statement-breakpoint

DELETE FROM "roles"
  WHERE "module_key" IS NULL
    AND "is_system" = true
    AND "slug" NOT IN ('OWNER', 'ORG_ADMIN', 'MEMBER');
