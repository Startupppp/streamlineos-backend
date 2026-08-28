-- Ticket 05. RBAC assigning/granting actors and stored module keys had no referential integrity:
-- assigned_by/granted_by were bare integers (a cross-tenant membership id was storable), every
-- module_key was free text, and a grant's module_key could disagree with the namespace of the
-- permission it grants. Every constraint is added NOT VALID then VALIDATE, so neither side takes a
-- long ACCESS EXCLUSIVE lock.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "permissions"
  ADD COLUMN IF NOT EXISTS "administering_module_key" text;
--> statement-breakpoint

UPDATE "permissions" p
SET "administering_module_key" = derived.key
FROM (
  SELECT
    id,
    CASE
      WHEN split_part(name, ':', 1) IN ('home', 'chat', 'mail', 'calendar', 'notifications') THEN 'home'
      WHEN split_part(name, ':', 1) IN ('crm', 'party') THEN 'crm'
      ELSE split_part(name, ':', 1)
    END AS key
  FROM "permissions"
) AS derived
WHERE p.id = derived.id
  AND EXISTS (SELECT 1 FROM "modules_catalog" mc WHERE mc.module_key = derived.key)
  AND p."administering_module_key" IS DISTINCT FROM derived.key;
--> statement-breakpoint

ALTER TABLE "permissions"
  DROP CONSTRAINT IF EXISTS "fk_permissions_administering_module";
--> statement-breakpoint
ALTER TABLE "permissions"
  ADD CONSTRAINT "fk_permissions_administering_module"
  FOREIGN KEY ("administering_module_key") REFERENCES "modules_catalog" ("module_key") NOT VALID;
--> statement-breakpoint
ALTER TABLE "permissions" VALIDATE CONSTRAINT "fk_permissions_administering_module";
--> statement-breakpoint

ALTER TABLE "permissions"
  DROP CONSTRAINT IF EXISTS "uniq_permissions_name_administering_module";
--> statement-breakpoint
ALTER TABLE "permissions"
  ADD CONSTRAINT "uniq_permissions_name_administering_module"
  UNIQUE ("name", "administering_module_key");
--> statement-breakpoint

ALTER TABLE "role_assignments"
  DROP CONSTRAINT IF EXISTS "fk_role_assignments_assigner_membership";
--> statement-breakpoint
ALTER TABLE "role_assignments"
  ADD CONSTRAINT "fk_role_assignments_assigner_membership"
  FOREIGN KEY ("org_id", "assigned_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assigned_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "role_assignments" VALIDATE CONSTRAINT "fk_role_assignments_assigner_membership";
--> statement-breakpoint

ALTER TABLE "user_permission_grants"
  DROP CONSTRAINT IF EXISTS "fk_user_permission_grants_granter_membership";
--> statement-breakpoint
ALTER TABLE "user_permission_grants"
  ADD CONSTRAINT "fk_user_permission_grants_granter_membership"
  FOREIGN KEY ("org_id", "granted_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("granted_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_permission_grants" VALIDATE CONSTRAINT "fk_user_permission_grants_granter_membership";
--> statement-breakpoint

ALTER TABLE "roles"
  DROP CONSTRAINT IF EXISTS "fk_roles_module";
--> statement-breakpoint
ALTER TABLE "roles"
  ADD CONSTRAINT "fk_roles_module"
  FOREIGN KEY ("module_key") REFERENCES "modules_catalog" ("module_key") NOT VALID;
--> statement-breakpoint
ALTER TABLE "roles" VALIDATE CONSTRAINT "fk_roles_module";
--> statement-breakpoint

ALTER TABLE "module_ownerships"
  DROP CONSTRAINT IF EXISTS "fk_module_ownerships_module";
--> statement-breakpoint
ALTER TABLE "module_ownerships"
  ADD CONSTRAINT "fk_module_ownerships_module"
  FOREIGN KEY ("module_key") REFERENCES "modules_catalog" ("module_key") NOT VALID;
--> statement-breakpoint
ALTER TABLE "module_ownerships" VALIDATE CONSTRAINT "fk_module_ownerships_module";
--> statement-breakpoint

ALTER TABLE "ownership_transfers"
  DROP CONSTRAINT IF EXISTS "fk_ownership_transfers_module";
--> statement-breakpoint
ALTER TABLE "ownership_transfers"
  ADD CONSTRAINT "fk_ownership_transfers_module"
  FOREIGN KEY ("module_key") REFERENCES "modules_catalog" ("module_key") NOT VALID;
--> statement-breakpoint
ALTER TABLE "ownership_transfers" VALIDATE CONSTRAINT "fk_ownership_transfers_module";
--> statement-breakpoint

ALTER TABLE "user_module_access"
  DROP CONSTRAINT IF EXISTS "fk_user_module_access_module";
--> statement-breakpoint
ALTER TABLE "user_module_access"
  ADD CONSTRAINT "fk_user_module_access_module"
  FOREIGN KEY ("module_key") REFERENCES "modules_catalog" ("module_key") NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_module_access" VALIDATE CONSTRAINT "fk_user_module_access_module";
--> statement-breakpoint

ALTER TABLE "user_permission_grants"
  DROP CONSTRAINT IF EXISTS "fk_user_permission_grants_module";
--> statement-breakpoint
ALTER TABLE "user_permission_grants"
  ADD CONSTRAINT "fk_user_permission_grants_module"
  FOREIGN KEY ("module_key") REFERENCES "modules_catalog" ("module_key") NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_permission_grants" VALIDATE CONSTRAINT "fk_user_permission_grants_module";
--> statement-breakpoint

ALTER TABLE "user_permission_grants"
  DROP CONSTRAINT IF EXISTS "fk_user_permission_grants_permission_module";
--> statement-breakpoint
ALTER TABLE "user_permission_grants"
  ADD CONSTRAINT "fk_user_permission_grants_permission_module"
  FOREIGN KEY ("permission_key", "module_key")
  REFERENCES "permissions" ("name", "administering_module_key") NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_permission_grants" VALIDATE CONSTRAINT "fk_user_permission_grants_permission_module";
--> statement-breakpoint

DO $$
DECLARE
  expected text[] := ARRAY[
    'fk_permissions_administering_module',
    'fk_role_assignments_assigner_membership',
    'fk_user_permission_grants_granter_membership',
    'fk_roles_module',
    'fk_module_ownerships_module',
    'fk_ownership_transfers_module',
    'fk_user_module_access_module',
    'fk_user_permission_grants_module',
    'fk_user_permission_grants_permission_module'
  ];
  name text;
  unvalidated integer;
  undermapped integer;
BEGIN
  FOREACH name IN ARRAY expected LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = name) THEN
      RAISE EXCEPTION '0634: constraint % is missing after migration', name;
    END IF;
  END LOOP;

  SELECT count(*) INTO unvalidated
  FROM pg_constraint
  WHERE conname = ANY(expected) AND NOT convalidated;
  IF unvalidated > 0 THEN
    RAISE EXCEPTION '0634: % constraint(s) remain NOT VALID', unvalidated;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_permissions_name_administering_module' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION '0634: uniq_permissions_name_administering_module is missing';
  END IF;

  SELECT count(*) INTO undermapped
  FROM "permissions" p
  JOIN "modules_catalog" mc
    ON mc.module_key = CASE
      WHEN split_part(p.name, ':', 1) IN ('home', 'chat', 'mail', 'calendar', 'notifications') THEN 'home'
      WHEN split_part(p.name, ':', 1) IN ('crm', 'party') THEN 'crm'
      ELSE split_part(p.name, ':', 1)
    END
  WHERE p."administering_module_key" IS NULL;
  IF undermapped > 0 THEN
    RAISE EXCEPTION '0634: % permission(s) resolve to a catalog module but were not backfilled', undermapped;
  END IF;
END $$;
