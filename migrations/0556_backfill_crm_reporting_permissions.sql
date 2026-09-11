-- The three reporting keys, granted to the organisations that already exist.
--
-- A newly created organisation needs nothing from this file: all three keys are
-- in `CRM_PERMISSIONS`, so `seedSystemRolesForOrg` hands them out at role
-- creation. Existing tenants cannot be reached that way -- the seeder grants
-- only when it creates a role (`if (inserted.length > 0)`), so re-seeding an
-- organisation that already has its roles adds nothing. Hence a backfill.
--
-- The slugs are `CRM_MODULE_OWNER|ADMIN|MEMBER`, which is what
-- `seedSystemRolesForOrg` actually mints. NOT `CRM_ADMIN`: that is a
-- `ROLE_TEMPLATES` slug an administrator may create a role from, and seven
-- migrations in the 02xx series granted to it, matched zero rows, and left
-- eighteen permissions granted to nobody. `ON CONFLICT DO NOTHING` over an empty
-- result set is a clean migration that did nothing, which is why that went
-- unnoticed until `0226` and `0232` repaired it. `backfill-slugs-exist.spec.ts`
-- now fails the build for a grant naming a slug the seeder never produces.
--
-- The split between the two statements below mirrors the seeder exactly, and
-- that is the invariant being preserved: a backfilled organisation and a freshly
-- seeded one must resolve to the same capability, or a tenant's permissions
-- depend on when they signed up.
--
--   `buildModuleAdminPermissionKeys` gives OWNER and ADMIN every `crm:` key.
--   `buildModuleMemberPermissionKeys` filters to keys ending `:view` or `:read`,
--   so MEMBER gets `crm:reporting:view` and neither of the other two.
--
-- That MEMBER does not receive `crm:reporting:run` is not incidental. Running a
-- report also requires the permission governing the source's rows
-- (`crm:deals:read`, `crm:activities:view`, `party:parties:view`), and the
-- module honours the KEY but ignores its data SCOPE -- a member holding
-- `crm:deals:read` at `own` would, if it could run reports, total the whole
-- organisation's pipeline. `scopeForGrant` gives every non-member slug `all`
-- scope, so the roles that do receive `run` here already read org-wide and the
-- gap costs nothing. See `REPORTING_SCOPE_GAP` in
-- `modules/reporting/reporting-source-access.ts`.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:reporting:view'), ('crm:reporting:manage'), ('crm:reporting:run')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  -- The catalogue sync inserts `permissions` rows on boot. Without this guard a
  -- backfill that ran before the sync would violate the grant's foreign key and
  -- fail the whole migration rather than skipping a row.
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Members get the read, and only the read. `crm:reporting:view` ends in `:view`,
-- so `buildModuleMemberPermissionKeys` gives it to a newly seeded
-- CRM_MODULE_MEMBER; granting it here is not generosity, it is the invariant
-- above. `crm:reporting:manage` and `crm:reporting:run` are deliberately absent
-- because the seeder would not give them either.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:reporting:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:reporting:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Resolved permissions are cached per organisation and keyed by this version.
-- Without the bump the grants above are invisible until a cache entry expires,
-- so the endpoints 403 for everybody for as long as the TTL lasts -- which reads
-- exactly like the backfill having failed.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
