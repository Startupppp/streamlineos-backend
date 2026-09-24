-- Rollback for migration 1160.
--
-- Drops the account tier column and its partial index, then the enum type.
-- The type is dropped last and only if no other column still references it.
--
-- @data-loss: business_parties.tier
-- Every tier a tenant has set is destroyed. Tier is entered by hand, not derived,
-- so it cannot be recomputed from anything else.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."idx_business_parties_org_tier";
--> statement-breakpoint

ALTER TABLE "public"."business_parties" DROP COLUMN IF EXISTS "tier";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE t.typname = 'crm_account_tier' AND NOT a.attisdropped
  ) THEN
    DROP TYPE IF EXISTS "public"."crm_account_tier";
  END IF;
END $$;
