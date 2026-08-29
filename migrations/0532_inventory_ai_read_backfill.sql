-- A6. `inventory:ai:read` splits the AI-assisted inventory surfaces (operations brief, digest,
-- insight explanations, supplier-delay briefing) off `inventory:reports:read`, so an organisation
-- can hand somebody the deterministic reports without handing them the model-backed ones.
--
-- Two halves, and both are needed:
--
-- 1. The key must exist as a catalogue row before any grant can reference it --
--    `role_permission_grants.permission_key` is a foreign key onto `permissions.name`, and
--    `PermissionCatalogSyncService` only writes that row at application boot, which is after this
--    migration runs. Inserting it here is what makes the grants below land at all.
--
-- 2. Role templates grant on role CREATION only -- `seed-system-roles.spec.ts` asserts a re-seed
--    must not touch an existing role's grants, so an owner's revocation is never silently restored.
--    A new key therefore reaches no organisation that already exists unless a backfill puts it
--    there. See `0436` for the shape.
--
-- The slug matters more than anything else here. Seven CRM migrations backfilled
-- `WHERE slug = 'CRM_ADMIN'` -- a `ROLE_TEMPLATES` slug an administrator may materialise, not what
-- an organisation is seeded with -- and granted eighteen permissions to nobody. `seedSystemRolesForOrg`
-- mints `${MODULE}_MODULE_OWNER|ADMIN|MEMBER`, and a query of the live database confirms those three
-- are the only `INVENTORY%` slugs that exist (8 organisations each) and the only holders of
-- `inventory:reports:read`. `INVENTORY_ADMIN` and `INVENTORY_MANAGER` name zero rows.
--
-- MODULE_MEMBER is included deliberately: `buildModuleMemberPermissionKeys` gives module members
-- every key ending in `:view` or `:read`, so a newly seeded organisation's member holds
-- `inventory:ai:read`. Leaving it out here would make a backfilled organisation differ from a fresh
-- one by signup date, which is the divergence `0226` exists to prevent.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key", "is_delegable")
VALUES (
  'inventory:ai:read',
  'inventory:ai',
  'read',
  'Read AI-assisted inventory surfaces: the operations brief, the digest, insight explanations and supplier-delay signals',
  'inventory',
  true
)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
VALUES ('inventory:ai:read', 'all')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:ai:read', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN', 'INVENTORY_MODULE_MEMBER')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The six AI endpoints used to answer to `inventory:reports:read`. Narrowing their gate without this
-- would revoke access from any role -- a materialised template, a bespoke one -- that holds the old
-- key, so the capability is carried across rather than taken away.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT g."org_id", g."role_id", 'inventory:ai:read', 'all'
FROM "role_permission_grants" g
WHERE g."permission_key" = 'inventory:reports:read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Same reasoning for a per-person grant, which hangs off the membership rather than a role.
INSERT INTO "user_permission_grants" ("org_id", "organization_membership_id", "permission_key", "scope", "module_key", "granted_by_membership_id", "reason")
SELECT u."org_id", u."organization_membership_id", 'inventory:ai:read', 'all', 'inventory', u."granted_by_membership_id",
       'Carried across from inventory:reports:read when the AI surfaces moved to inventory:ai:read'
FROM "user_permission_grants" u
WHERE u."permission_key" = 'inventory:reports:read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN', 'INVENTORY_MODULE_MEMBER')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
