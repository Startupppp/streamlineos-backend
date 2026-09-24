-- Rollback for migration 1131.
--
-- The forward migration deleted every `team` row from `permission_supported_scopes`.
-- Those rows are exactly reconstructible: `PermissionCatalogSyncService` emitted `own`
-- and `team` together for every scopable permission, so the surviving `own` rows name
-- precisely the keys that carried a `team` row (57 and 57 in production at the time).
--
-- WARNING: the grant normalisation is NOT reversible. A grant that read `team` before the
-- forward migration now reads `own`, and nothing records which rows were rewritten. On
-- every database measured there were zero such rows, so in practice this loses nothing —
-- but on a database that did hold `team` grants, restoring the offer does not restore the
-- grants, and those holders keep the `own` scope the runtime degrade was already giving
-- them.

SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
SELECT "permission_key", 'team'
FROM "permission_supported_scopes"
WHERE "scope" = 'own'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
