-- Custom SQL migration file, put your code below! --

-- Every CRM backfill in this series granted to a role that does not exist.
--
-- `0207`, `0210`, `0212`, `0216`, `0218`, `0221` and `0225` all wrote
-- `WHERE r."slug" = 'CRM_ADMIN'`, copied from `ROLE_TEMPLATES`. But that entry
-- is a template an administrator may *manually* create a role from; it is not
-- what any organisation is seeded with. `seedSystemRolesForOrg` mints
-- `${MODULE}_MODULE_OWNER`, `_MODULE_ADMIN` and `_MODULE_MEMBER`, so the CRM
-- roles that actually exist are `CRM_MODULE_*` and every one of those backfills
-- matched zero rows and inserted nothing.
--
-- The consequence was not subtle: sixteen permissions were granted to nobody in
-- any organisation, which left the entire party module, the inbound ingress
-- endpoint and the autonomy review feed unreachable by every user including org
-- owners of the CRM module. Nothing errored -- `ON CONFLICT DO NOTHING` over an
-- empty result set is a successful migration that does nothing.
--
-- This repairs all seven at once rather than one migration per ticket, because
-- they share a single cause and a single fix.
--
-- Two keys are renamed here as well. `crm:autonomy:review` and
-- `crm:autonomy:configure` became `:view` and `:manage`: members are seeded from
-- `moduleScopedPermissions` filtered to keys ending `:view` or `:read`, so an
-- action named `review` could never reach a member and a backfill granting it to
-- one would disagree with what a re-seed produces. Safe to rename rather than
-- alias, because neither key was ever granted to anybody. `:reverse` stays a
-- domain verb -- undoing an autonomous action carries authority `update` does
-- not express.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:autonomy:view', 'crm:autonomy', 'view',
   'Review what the CRM decided and did on its own', 'crm'),
  ('crm:autonomy:manage', 'crm:autonomy', 'manage',
   'Turn autonomous CRM action types on or off for the organisation', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- The superseded spellings. Held no grants, so this removes a catalog entry
-- rather than anyone's capability.
DELETE FROM "role_permission_grants"
WHERE "permission_key" IN ('crm:autonomy:review', 'crm:autonomy:configure');
--> statement-breakpoint
DELETE FROM "permissions"
WHERE "name" IN ('crm:autonomy:review', 'crm:autonomy:configure');

--> statement-breakpoint
-- Owners and admins receive the module's whole namespace, which is what
-- `buildModuleAdminPermissionKeys` gives a newly seeded organisation.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('party:parties:view'), ('party:parties:create'), ('party:parties:update'),
  ('party:parties:delete'), ('party:contacts:view'), ('party:contacts:manage'),
  ('party:roles:manage'), ('party:duplicates:view'), ('party:merges:manage'),
  ('party:subjects:view'), ('party:subjects:manage'), ('party:subject-types:manage'),
  ('crm:ingress:submit'),
  ('crm:autonomy:view'), ('crm:autonomy:reverse'), ('crm:autonomy:manage')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Members receive only the read keys, matching
-- `buildModuleMemberPermissionKeys`, which filters the same namespace to keys
-- ending `:view` or `:read`. Kept identical on purpose: a backfilled
-- organisation and a freshly seeded one must resolve to the same capability, or
-- behaviour depends on when the tenant signed up.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('party:parties:view'), ('party:contacts:view'),
  ('party:duplicates:view'), ('party:subjects:view'),
  ('crm:autonomy:view')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
