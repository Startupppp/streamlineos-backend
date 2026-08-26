-- Document attachments arrived gated on the coarse `accounting:read` / `:create` / `:update` keys,
-- which was wrong in two ways. It let anyone holding module-wide read pull a vendor bill's
-- attachments, and `accounting:update` is not in the ACCOUNTANT template while `:create` is -- so an
-- Accountant could attach a file and then not remove it. `accounting:attachments:read|manage` gates
-- the routes now, with attach and delete on the SAME key so the pair cannot drift apart again.
--
-- Role templates only grant on role CREATION -- `seed-system-roles.spec.ts` asserts a re-seed must
-- not touch an existing role's grants -- so a new key never reaches an organisation that already
-- exists. This backfills onto the two SEEDED system roles, and nothing else.
-- ACCOUNTING_MODULE_OWNER/_ADMIN are generated from the module namespace by seed-system-roles, so
-- they are named by slug here rather than by the template id.
--
-- ACCOUNTANT is deliberately NOT named here. It is a `ROLE_TEMPLATES` slug -- something an
-- administrator may create a role from -- not a shape `seedSystemRolesForOrg` has ever minted, so
-- naming it in the predicate matches zero rows and grants to nobody. That is the exact failure the
-- CRM seven made; see `backfill-slugs-exist.spec.ts`. The Accountant template already carries both
-- attachment keys, so a role created from it gets them at creation and there is nothing to repair.
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
  AND r."slug" IN ('ACCOUNTING_MODULE_OWNER', 'ACCOUNTING_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."name")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('ACCOUNTING_MODULE_OWNER', 'ACCOUNTING_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
