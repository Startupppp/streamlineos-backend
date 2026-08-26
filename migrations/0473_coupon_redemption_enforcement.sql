-- 0473 — coupon redemption enforcement
-- =============================================================================
-- Bug: coupon.usedCount was never incremented and no row was ever inserted into
-- coupon_redemptions, so BOTH application guards were inert. A single-use
-- coupon was reusable forever by anyone.
--
-- Fix (application layer): verifyAndActivate now accepts an optional couponId.
-- Inside the same transaction that activates the subscription it:
--   1. SELECTs the coupon FOR UPDATE (serialises concurrent redemptions).
--   2. Checks usedCount >= maxUses under the lock (fast-path friendly error).
--   3. UPDATEs coupons SET used_count = used_count + 1.
--   4. INSERTs a coupon_redemptions row.
--
-- Fix (DB layer): the UNIQUE constraint uq_coupon_redemptions_coupon_org on
-- (coupon_id, org_id) was already created in migration 0000 inline in the
-- CREATE TABLE statement. Two concurrent redemptions from the same org both
-- pass step 2 (they both see the pre-increment count under their own lock
-- wait), but only one INSERT succeeds — the other receives 23505 with
-- constraint name "uq_coupon_redemptions_coupon_org", which the service maps
-- to ConflictException instead of swallowing it as an idempotent payment
-- replay.
--
-- Unique key chosen: (coupon_id, org_id)
-- Coupons are scoped to organisations (each org has its own subscription and
-- billing flow). The coupon_redemptions.org_id is always the subscribing org;
-- the same coupon may be used by at most one payment per org, which is the
-- business rule. maxUses enforces the global cap across all orgs via the
-- counter + FOR UPDATE lock.
--
-- Existing rows: coupon_redemptions has always been empty (the bug is that
-- rows were never inserted). Zero rows → no duplicate risk.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_coupon_redemptions_coupon_org'
      AND conrelid = 'coupon_redemptions'::regclass
  ) THEN
    ALTER TABLE coupon_redemptions
      ADD CONSTRAINT uq_coupon_redemptions_coupon_org
      UNIQUE (coupon_id, org_id);
  END IF;
END $$;
