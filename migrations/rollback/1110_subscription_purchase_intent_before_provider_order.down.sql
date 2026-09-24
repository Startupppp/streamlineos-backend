-- Rollback for migration 1110.
--
-- The forward migration dropped the NOT NULL constraint on provider_order_id and added
-- a partial index for unclaimed intent rows (WHERE provider_order_id IS NULL). Reversal
-- in dependency order: drop the partial index first, then restore the NOT NULL constraint.
--
-- PRECONDITION / DATA LOSS RISK: ALTER COLUMN SET NOT NULL will fail if any
-- subscription_purchases row has a NULL provider_order_id. Intent rows written after
-- migration 1110 will carry a NULL here by design. An operator must delete or backfill
-- those rows before applying this rollback. Deleting intent rows with no matching
-- provider order destroys the record of that purchase attempt with no reconstruction path.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_subscription_purchases_unclaimed_intent";
--> statement-breakpoint
ALTER TABLE "subscription_purchases" ALTER COLUMN "provider_order_id" SET NOT NULL;
