-- sign:envelope:view_all is retired; DataScope on sign:envelope:view replaces it.
--
-- Previously the list controller checked u.permissions.includes("sign:envelope:view_all")
-- as a secondary gate. That bypasses DataScope and is invisible to scope audits. After
-- this migration the controller reads req.rbacScope (set by PermissionGuard from the grant
-- scope on sign:envelope:view) and view_all is gone.
--
-- Three mapping rules, applied to all three grant tables:
--
--   1. Principal holds view_all (with or without view):
--      → upsert sign:envelope:view at scope 'all'; delete view_all.
--
--   2. Principal holds view but NOT view_all:
--      → update sign:envelope:view to scope 'own'.
--
-- user_delegation_permissions has no scope column; only an INSERT + DELETE is needed.
--
-- The final INSERT INTO access_versions bumps permissions_version for every org so that
-- cached permission resolutions are immediately invalidated across all nodes.
SET lock_timeout = '5s';
--> statement-breakpoint
-- ── role_permission_grants ──────────────────────────────────────────────────────────────
-- Rule 1a: roles with BOTH view AND view_all → promote view to scope 'all'.
UPDATE "role_permission_grants" rpg
SET "scope" = 'all'
WHERE rpg."permission_key" = 'sign:envelope:view'
  AND EXISTS (
    SELECT 1 FROM "role_permission_grants" v
    WHERE v."org_id" = rpg."org_id"
      AND v."role_id" = rpg."role_id"
      AND v."permission_key" = 'sign:envelope:view_all'
  );
--> statement-breakpoint
-- Rule 1b: roles with view_all but NOT view → insert view at scope 'all'.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT src."org_id", src."role_id", 'sign:envelope:view', 'all'
FROM "role_permission_grants" src
WHERE src."permission_key" = 'sign:envelope:view_all'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permission_grants" v
    WHERE v."org_id" = src."org_id"
      AND v."role_id" = src."role_id"
      AND v."permission_key" = 'sign:envelope:view'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Rule 2: roles with view but NOT view_all → set scope to 'own'.
UPDATE "role_permission_grants" rpg
SET "scope" = 'own'
WHERE rpg."permission_key" = 'sign:envelope:view'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permission_grants" v
    WHERE v."org_id" = rpg."org_id"
      AND v."role_id" = rpg."role_id"
      AND v."permission_key" = 'sign:envelope:view_all'
  );
--> statement-breakpoint
DELETE FROM "role_permission_grants"
WHERE "permission_key" = 'sign:envelope:view_all';
--> statement-breakpoint
-- ── user_permission_grants ──────────────────────────────────────────────────────────────
-- Rule 1a: members with BOTH view AND view_all → promote view to scope 'all'.
UPDATE "user_permission_grants" upg
SET "scope" = 'all'
WHERE upg."permission_key" = 'sign:envelope:view'
  AND EXISTS (
    SELECT 1 FROM "user_permission_grants" v
    WHERE v."org_id" = upg."org_id"
      AND v."organization_membership_id" = upg."organization_membership_id"
      AND v."permission_key" = 'sign:envelope:view_all'
  );
--> statement-breakpoint
-- Rule 1b: members with view_all but NOT view → insert view at scope 'all'.
INSERT INTO "user_permission_grants" ("org_id", "organization_membership_id", "permission_key", "scope", "module_key", "granted_by_membership_id")
SELECT src."org_id", src."organization_membership_id", 'sign:envelope:view', 'all', src."module_key", src."granted_by_membership_id"
FROM "user_permission_grants" src
WHERE src."permission_key" = 'sign:envelope:view_all'
  AND NOT EXISTS (
    SELECT 1 FROM "user_permission_grants" v
    WHERE v."org_id" = src."org_id"
      AND v."organization_membership_id" = src."organization_membership_id"
      AND v."permission_key" = 'sign:envelope:view'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Rule 2: members with view but NOT view_all → set scope to 'own'.
UPDATE "user_permission_grants" upg
SET "scope" = 'own'
WHERE upg."permission_key" = 'sign:envelope:view'
  AND NOT EXISTS (
    SELECT 1 FROM "user_permission_grants" v
    WHERE v."org_id" = upg."org_id"
      AND v."organization_membership_id" = upg."organization_membership_id"
      AND v."permission_key" = 'sign:envelope:view_all'
  );
--> statement-breakpoint
DELETE FROM "user_permission_grants"
WHERE "permission_key" = 'sign:envelope:view_all';
--> statement-breakpoint
-- ── user_delegation_permissions ─────────────────────────────────────────────────────────
-- No scope column. Delegations with view_all but NOT view get a view grant inserted.
INSERT INTO "user_delegation_permissions" ("org_id", "delegation_id", "permission_key")
SELECT src."org_id", src."delegation_id", 'sign:envelope:view'
FROM "user_delegation_permissions" src
WHERE src."permission_key" = 'sign:envelope:view_all'
  AND NOT EXISTS (
    SELECT 1 FROM "user_delegation_permissions" v
    WHERE v."delegation_id" = src."delegation_id"
      AND v."permission_key" = 'sign:envelope:view'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "user_delegation_permissions"
WHERE "permission_key" = 'sign:envelope:view_all';
--> statement-breakpoint
-- ── permissions catalog ─────────────────────────────────────────────────────────────────
-- All grant-table rows for view_all are gone (deleted above); the cascade and restrict
-- FKs are satisfied. Delete the key itself so the catalog is consistent before the
-- sync service runs on next boot.
DELETE FROM "permissions"
WHERE "name" = 'sign:envelope:view_all';
--> statement-breakpoint
-- ── cache invalidation ──────────────────────────────────────────────────────────────────
-- Resolution is cached per (userId, orgId) and busted by permissions_version. Bump every
-- org so no principal keeps a stale scope until their TTL expires.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
