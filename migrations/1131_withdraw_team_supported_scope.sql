-- 1131 — withdraw `team` as a grantable scope, because the query layer cannot honour it.
--
-- `apply-scope.ts:22-27` falls back to `eq(ownerColumn, userId)` whenever `teamIds` is
-- absent, and the only runtime caller (`scoped-read.ts:106`) never supplies it. So a
-- `team` grant returns the holder's OWN rows, silently — the grant surface advertises a
-- breadth the read path does not deliver. backend/CLAUDE.md §5 already states that `team`
-- "ships only once materialised"; the defect is that the offer shipped first.
--
-- Returning `sql`false`` from apply-scope was implemented and backed out: ADR 0005 ranks
-- `none < own < team < all` and `broadest()` depends on that order, so denying at `team`
-- makes the broader grant return strictly fewer rows than the narrower one. `team` therefore
-- stays a valid DataScope value and `broadest()` is untouched. What is withdrawn is only
-- the OFFER.
--
-- Why a migration and not just the catalogue edit: `PermissionCatalogSyncService` writes
-- `permission_supported_scopes` with `insert(...).onConflictDoNothing()` and has no delete
-- branch, so removing the emission stops the offer on a fresh database and leaves the
-- existing rows standing everywhere else. Precedent 0670a withdrew `crm:contacts:view`'s
-- `own`/`team` rows for exactly this reason.
--
-- Measured against production immediately before writing this: `permission_supported_scopes`
-- holds 755 `all`, 57 `own` and 57 `team` rows — the `own`/`team` parity is the sync service
-- emitting both for every scopable key, which is what makes the rollback exact.
-- `role_permission_grants` holds 27,688 `all` and 120 `own` and **zero** `team`;
-- `user_permission_grants` is empty. So this withdraws a dormant offer and moves nobody's
-- access.
--
-- The grant normalisation below is defensive, not corrective. It writes `own` rather than
-- 0670a's `all` because `own` is what a `team` holder has actually been getting from the
-- degrade — widening to `all` here would grant access the degrade never gave.
SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE "role_permission_grants"
SET "scope" = 'own'
WHERE "scope" = 'team';
--> statement-breakpoint
UPDATE "user_permission_grants"
SET "scope" = 'own'
WHERE "scope" = 'team';
--> statement-breakpoint
-- `user_delegation_permissions` carries no scope column, so a delegation has nothing to fix.
DELETE FROM "permission_supported_scopes"
WHERE "scope" = 'team';
--> statement-breakpoint
-- Resolution is cached per (userId, orgId) and busted by permissions_version. The UPDATEs
-- above are no-ops on every database measured, but skipping the bump on a database where
-- they were not would serve a withdrawn scope until the TTL expired.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
--> statement-breakpoint
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining FROM "permission_supported_scopes" WHERE "scope" = 'team';
  IF remaining <> 0 THEN
    RAISE EXCEPTION '1131: % team rows survived the withdrawal', remaining;
  END IF;
  SELECT count(*) INTO remaining FROM "role_permission_grants" WHERE "scope" = 'team';
  IF remaining <> 0 THEN
    RAISE EXCEPTION '1131: % role grants still carry the withdrawn scope', remaining;
  END IF;
END
$$;
