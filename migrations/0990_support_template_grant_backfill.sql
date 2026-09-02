-- The CUSTOMER_SUPPORT template granted `support:tickets:manage` without `support:tickets:view`,
-- and nothing implies one from the other on the resolution path: `impliedViewKey` is applied only by
-- `normalizeModulePermissionItems` on the module-access grant path, never by `computeUserPermissions`.
-- A seeded support agent was therefore refused the module's own inbox by the backend. Role templates
-- only grant on role CREATION -- `seed-system-roles.spec.ts` asserts a re-seed must not touch an
-- existing role's grants -- so the six added keys never reach an organisation that already exists.
-- This backfills them onto the CUSTOMER_SUPPORT role, and nothing else.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (
  VALUES
    ('support:tickets:view'),
    ('support:tickets:create'),
    ('support:tickets:reply'),
    ('support:reports:view'),
    ('support:knowledge-gaps:view'),
    ('support:csat:view')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" = 'CUSTOMER_SUPPORT'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" = 'CUSTOMER_SUPPORT'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
