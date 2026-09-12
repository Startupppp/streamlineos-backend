-- Four inventory keys the remaining programme needs, backfilled onto the module
-- rungs that already administer inventory. Role templates grant on role CREATION
-- only -- `seed-system-roles.spec.ts` asserts a re-seed must not touch an existing
-- role's grants, so an owner's revocation is never silently restored -- which means
-- a new key is inert in every organisation that already exists until it is
-- backfilled here.
--
-- The target is the module rungs (`INVENTORY_MODULE_OWNER` / `INVENTORY_MODULE_ADMIN`),
-- not the `ROLE_TEMPLATES` slugs: those are what `seedSystemRolesForOrg` actually
-- writes for module administration, and naming a template slug instead fails
-- silently -- no rows, no error.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description")
VALUES
  ('inventory:replenishment:read', 'inventory:replenishment', 'read', 'View replenishment proposals, transfer recommendations and forecast drift'),
  ('inventory:allocation:override', 'inventory:allocation', 'override', 'Override FEFO or a near-expiry block when allocating a lot, with a recorded reason'),
  ('inventory:transit:abandon', 'inventory:transit', 'abandon', 'Abandon or return-to-source stock stranded in transit by a short receipt'),
  ('inventory:labels:print', 'inventory:labels', 'print', 'Print barcode labels, goods-receipt notes and pick lists')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('inventory:replenishment:read'),
  ('inventory:allocation:override'),
  ('inventory:transit:abandon'),
  ('inventory:labels:print')
) AS k("key")
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."key")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
