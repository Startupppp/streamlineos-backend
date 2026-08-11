-- 0405.down — Revert reservation idempotency.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "uniq_inv_reservations_org_source_active";
DROP INDEX IF EXISTS "uniq_inv_reservations_org_idem";
ALTER TABLE "inv_stock_reservations" DROP COLUMN IF EXISTS "idempotency_key";
