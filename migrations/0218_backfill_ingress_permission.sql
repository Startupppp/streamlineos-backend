-- Custom SQL migration file, put your code below! --

-- The ingress key, seeded and backfilled onto the CRM role. Catalog rows first,
-- for the reason recorded in 0212: PermissionCatalogSyncService runs at
-- application boot, after db:migrate, so the guard below is otherwise false when
-- this runs and the grant inserts nothing.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:ingress:submit', 'crm:ingress', 'submit',
   'Deliver a normalised inbound communication event into the CRM', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:ingress:submit', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_ADMIN'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:ingress:submit')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" = 'CRM_ADMIN'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
