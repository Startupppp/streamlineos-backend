-- Document attachments arrived gated on the coarse `accounting:read` / `:create` / `:update` keys,
-- which was wrong in two ways. It let anyone holding module-wide read pull a vendor bill's
-- attachments, and `accounting:update` is not in the ACCOUNTANT template while `:create` is -- so an
-- Accountant could attach a file and then not remove it. `accounting:attachments:read|manage` gates
-- the routes now, with attach and delete on the SAME key so the pair cannot drift apart again.
--
-- Role templates only grant on role CREATION -- `seed-system-roles.spec.ts` asserts a re-seed must
-- not touch an existing role's grants -- so a new key never reaches an organisation that already
-- exists. This backfills onto the three system roles the templates give it to, and nothing else.
-- ACCOUNTING_MODULE_OWNER/_ADMIN are generated from the module namespace by seed-system-roles, so
-- they are named by slug here rather than by the template id.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('accounting:attachments:read', 'accounting:attachments', 'read',
   'List and download files attached to accounting documents', 'accounting'),
  ('accounting:attachments:manage', 'accounting:attachments', 'manage',
   'Attach files to accounting documents, and remove them', 'accounting')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."name", 'all'
FROM "roles" r
CROSS JOIN (VALUES ('accounting:attachments:read'), ('accounting:attachments:manage')) AS k("name")
WHERE r."is_system" = true
  AND r."slug" IN ('ACCOUNTING_MODULE_OWNER', 'ACCOUNTING_MODULE_ADMIN', 'ACCOUNTANT')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."name")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('ACCOUNTING_MODULE_OWNER', 'ACCOUNTING_MODULE_ADMIN', 'ACCOUNTANT')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
