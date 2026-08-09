-- 0398: Backfill three recruitment permission grants that were added to the
-- HR_ADMIN and BRANCH_HR role templates but were not propagated to existing
-- orgs' snapshot-cloned roles.
--
-- Keys: hr:interviews:view, hr:interviews:manage, hr:offers:view
-- Scope: 'all' — mirrors every existing hr:requisitions/interviews/offers grant
-- on these templates, and is the schema default for role_permission_grants.scope.
--
-- Idempotency: ON CONFLICT (org_id, role_id, permission_key) DO NOTHING targets
-- the unique index uniq_role_permission_grants_role_key (a uniqueIndex, not a
-- named constraint, so the column-list form is used).
--
-- Cache invalidation: access_versions.permissions_version is incremented once
-- per org whose roles include HR_ADMIN or BRANCH_HR, matching
-- bumpPermissionsVersion() semantics exactly.

SET statement_timeout = 0;
SET lock_timeout = '5s';

INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'::data_scope
FROM "roles" AS r
CROSS JOIN (
  VALUES
    ('hr:interviews:view'),
    ('hr:interviews:manage'),
    ('hr:offers:view')
) AS k("permission_key")
WHERE r."slug" IN ('HR_ADMIN', 'BRANCH_HR')
ON CONFLICT ("org_id", "role_id", "permission_key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 1, NOW()
FROM "roles" AS r
WHERE r."slug" IN ('HR_ADMIN', 'BRANCH_HR')
ON CONFLICT ("org_id") DO UPDATE
  SET "permissions_version" = "access_versions"."permissions_version" + 1,
      "updated_at" = NOW();
