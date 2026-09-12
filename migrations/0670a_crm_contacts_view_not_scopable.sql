-- `crm:contacts:view` stops offering `own` and `team`, because nothing could ever apply them.
--
-- The catalogue entry declared `scopable: true` from the day the key was born, and no route
-- ever read a scope from it: `modules/contacts/` contains no `applyScope`, no `DataScope` and
-- no `readRequestScope`, and `contacts.controller.ts` lists on `(orgId, filters)` with no
-- caller identity. That is a REQUIREMENT nothing satisfies — an administrator grants a rep
-- `own`, the product accepts it, stores it and shows it back on the access screen, and every
-- contact in the organisation stays visible.
--
-- It is being withdrawn rather than implemented because a contact has no owner to scope by.
-- The legacy `contacts` row has no owner column (only `organization_id`, `lead_id`,
-- `deal_id`); Party — canonical since ticket 02, and where these reads actually resolve —
-- keeps `business_parties.owner_user_id`, but `party-mirror-fields.ts` maps it for LEAD and
-- CLIENT only, so a CONTACT-role party has it null by construction; and `crm_organizations`,
-- the employer that "contacts on accounts I own" would lean on, has no owner column either.
-- The successor route agrees: `party:contacts:view` is not scopable.
--
-- Why a migration and not just the catalogue edit. `PermissionCatalogSyncService` writes
-- `permission_supported_scopes` with `insert(...).onConflictDoNothing()` and has no delete
-- branch; no migration has ever deleted from that table. So removing `scopable: true` stops
-- the offer on a fresh database and leaves migration 0343's `own`/`team` rows standing in
-- every existing one — the code would be honest and the database would still be lying.
--
-- Grant normalisation is defensive, not corrective: measured before writing this, all four
-- `crm:contacts:view` grants are at `all` and `user_permission_grants` holds none, so this
-- withdraws a dormant offer and moves nobody's access. It is written anyway because a
-- migration must be correct on a database it has not seen.
SET lock_timeout = '5s';
--> statement-breakpoint
-- ── grant tables ────────────────────────────────────────────────────────────────────────
-- Any narrow grant is a restriction that was never enforced, so `all` is what the holder
-- has actually had all along. Widening the stored value to match observed behaviour changes
-- no one's access; leaving it would strand a scope the catalogue no longer offers.
UPDATE "role_permission_grants"
SET "scope" = 'all'
WHERE "permission_key" = 'crm:contacts:view'
  AND "scope" <> 'all';
--> statement-breakpoint
UPDATE "user_permission_grants"
SET "scope" = 'all'
WHERE "permission_key" = 'crm:contacts:view'
  AND "scope" <> 'all';
--> statement-breakpoint
-- `user_delegation_permissions` has no scope column, so a delegation carries nothing to fix.
-- ── supported scopes ────────────────────────────────────────────────────────────────────
-- What 0343 offered. `all` stays: it is the row the sync service writes for every key,
-- scopable or not, and deleting it would make the key ungrantable.
DELETE FROM "permission_supported_scopes"
WHERE "permission_key" = 'crm:contacts:view'
  AND "scope" IN ('own', 'team');
--> statement-breakpoint
-- ── cache invalidation ──────────────────────────────────────────────────────────────────
-- Resolution is cached per (userId, orgId) and busted by permissions_version. The UPDATEs
-- above are no-ops on every database measured, but a bump costs one resolution and skipping
-- it on a database where they were not would leave a stale scope until the TTL expired.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
