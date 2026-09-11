-- coupons.code carried a global UNIQUE while coupons.org_id makes the row
-- tenant-owned, and BillingCouponsService.create() inserts with the caller's
-- org_id and maps 23505 to a 409. Two consequences, both cross-tenant:
-- the first organisation to claim SUMMER25 denies that code to every other
-- organisation permanently, and the 409 answers "does some other tenant already
-- own this code?" for any code a caller cares to guess.
--
-- Replaced by two partial unique indexes, the shape email_suppressions and
-- notification_events already use: platform coupons (org_id IS NULL) stay
-- globally unique on code, tenant coupons are unique per (org_id, code).
--
-- Both new rules are strictly weaker than the constraint being dropped, so on any
-- database still holding coupons_code_unique no collision is representable. The
-- pre-pass exists for a database that lost the constraint some other way — a
-- drizzle-kit push against a dev database, or a partial rollback. It resolves
-- collisions rather than aborting: the lowest id in each group keeps the code,
-- the rest are suffixed with their own id and deactivated, so the row survives
-- for inspection and cannot be redeemed under a code it no longer owns.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  renamed integer := 0;
BEGIN
  WITH dup AS (
    SELECT id,
           row_number() OVER (PARTITION BY org_id, code ORDER BY id) AS rn
    FROM coupons
  )
  UPDATE coupons c
     SET code = c.code || '-DUP' || c.id,
         is_active = false
    FROM dup
   WHERE dup.id = c.id
     AND dup.rn > 1;

  GET DIAGNOSTICS renamed = ROW_COUNT;

  IF renamed > 0 THEN
    RAISE NOTICE '0993: renamed and deactivated % duplicate coupon code(s) so the tenant-scoped uniques can be built', renamed;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_code_unique;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_coupons_platform_code
  ON coupons (code)
  WHERE org_id IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_coupons_org_code
  ON coupons (org_id, code)
  WHERE org_id IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    WHERE r.relname = 'coupons' AND c.conname = 'coupons_code_unique'
  ) THEN
    RAISE EXCEPTION '0993: the global UNIQUE(code) on coupons is still present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'uniq_coupons_platform_code' AND relkind = 'i'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'uniq_coupons_org_code' AND relkind = 'i'
  ) THEN
    RAISE EXCEPTION '0993: the tenant-scoped coupon code uniques were not created';
  END IF;
END $$;
