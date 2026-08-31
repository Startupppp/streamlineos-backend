-- Rollback for 0142_tickets_fractional_rank
--
-- PARTIAL REVERSIBILITY WARNING:
-- Migration 0142 dropped tickets."order" (integer) and replaced it with
-- tickets.rank (numeric). This rollback recreates "order" by deriving
-- ROUND((rank / 1000) - 1)::integer, which exactly reverses the forward
-- formula (rank = (order + 1) * 1000) for integers that were never
-- fractionally split. Any rank that was written as a fraction (e.g. 1500,
-- inserted between order=0 and order=1) will produce a non-integer that
-- gets rounded; the relative ordering is preserved but the exact original
-- integer values are not recoverable. This limitation is irreversible
-- without an external backup of the original "order" column.
--
-- Migration 0432 moved tickets from public to the build schema.
-- All table references and index qualifiers use build. accordingly.
--
-- NOTE: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction.
-- Non-concurrent forms are used here for transaction-safe verification.

SET lock_timeout = '5s';
SET statement_timeout = 0;

-- 1. Re-add the "order" column (nullable first so backfill can proceed).
ALTER TABLE "build"."tickets" ADD COLUMN "order" integer;

-- 2. Backfill from rank (reverses the forward formula, rounds fractional splits).
UPDATE "build"."tickets" SET "order" = ROUND((rank / 1000) - 1)::integer;

-- 3. Set NOT NULL now that all rows are populated.
ALTER TABLE "build"."tickets" ALTER COLUMN "order" SET NOT NULL;

-- 4. Restore the original index on the pre-0142 column set.
CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_order"
  ON "build"."tickets" (org_id, project_id, "order");

-- 5. Drop the rank index added by 0142.
DROP INDEX IF EXISTS "build"."idx_tickets_org_project_rank";

-- 6. Drop the rank column.
ALTER TABLE "build"."tickets" DROP COLUMN rank;
