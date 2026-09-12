-- B9 — returns get an approval step, a fourth disposition and a credit pointer.
--
-- A return went DRAFT -> POSTED, so agreeing to move the stock and moving it
-- were the same click. INV-209 made the inspection a recorded act with an
-- author; nobody signed it off, and a cancellation had exactly one moment it
-- could happen in. `APPROVED` is that moment.
--
-- Shape notes, per backend/CLAUDE.md §3 Migrations:
--   * `lock_timeout` so this fails fast rather than queueing behind a long read
--     and blocking every write to the two return tables behind it;
--   * no `CONCURRENTLY` — drizzle wraps all pending migrations in ONE
--     transaction (see 0533), and `CREATE INDEX CONCURRENTLY` cannot run inside
--     a transaction block at all;
--   * no FK and no NOT NULL here, so no `NOT VALID` -> `VALIDATE` split is
--     needed: every column added is nullable and every index is on a small
--     document table.
--
-- `ALTER TYPE … ADD VALUE` inside a transaction block is legal from PostgreSQL
-- 12 on, with one rule: the new label may not be *used* before the transaction
-- commits. Nothing below references 'APPROVED' or 'RETURN_TO_VENDOR' — the
-- backfill matches on 'POSTED', which already exists.
SET lock_timeout = '5s';
--> statement-breakpoint
-- Ordered after DRAFT so the label order matches the lifecycle order; an enum
-- sorts by declaration order, and a status column is sorted on.
ALTER TYPE "inv_return_status" ADD VALUE IF NOT EXISTS 'APPROVED' AFTER 'DRAFT';
--> statement-breakpoint
-- The fourth answer an inspector can give: faulty, and the supplier's fault.
-- The goods arrive, are not sellable, and are not written off either — they
-- wait for a vendor RMA. Posted as BLOCKED stock, which availability already
-- subtracts, rather than as a status flag nothing enforces.
ALTER TYPE "inv_customer_return_disposition" ADD VALUE IF NOT EXISTS 'RETURN_TO_VENDOR';
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns"
  ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
--> statement-breakpoint
-- Item 5. An expected credit or refund is a reference into whatever system
-- issues it, never a condition on the stock movement. Nothing in this codebase
-- reads it back; it exists so an accounting adapter can reconcile, and so that
-- "we owe them a credit" is not recorded by leaving goods off the shelf.
ALTER TABLE "inv_vendor_returns"
  ADD COLUMN IF NOT EXISTS "credit_reference" text;
--> statement-breakpoint
ALTER TABLE "inv_customer_returns"
  ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
--> statement-breakpoint
ALTER TABLE "inv_customer_returns"
  ADD COLUMN IF NOT EXISTS "credit_reference" text;
--> statement-breakpoint
-- The create API has always accepted a per-line `targetLocationId` and always
-- thrown it away — there was no column to put it in — so every return landed
-- wherever `resolveTargetLocation` guessed. Persisted now, because a warehouse
-- that has decided which bin returned goods go to should not have to re-decide
-- it at posting time.
ALTER TABLE "inv_customer_return_lines"
  ADD COLUMN IF NOT EXISTS "target_location_id" integer;
--> statement-breakpoint
-- Split into NOT VALID + VALIDATE per §3: a bare ADD CONSTRAINT … FOREIGN KEY
-- takes ACCESS EXCLUSIVE on both sides for the whole validating scan, and one
-- of those sides is `inv_locations`, which every stock command reads.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_inv_customer_return_lines_target_location_id'
  ) THEN
    ALTER TABLE "inv_customer_return_lines"
      ADD CONSTRAINT "fk_inv_customer_return_lines_target_location_id"
      FOREIGN KEY ("target_location_id") REFERENCES "inv_locations"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_customer_return_lines"
  VALIDATE CONSTRAINT "fk_inv_customer_return_lines_target_location_id";
--> statement-breakpoint
-- Already-posted returns had `approved_by` stamped by the post itself, so the
-- approval and the posting genuinely were the same instant. Recording that
-- instant is more honest than leaving the column null and implying the approval
-- never happened.
UPDATE "inv_vendor_returns"
   SET "approved_at" = "posted_at"
 WHERE "status" = 'POSTED' AND "approved_at" IS NULL AND "posted_at" IS NOT NULL;
--> statement-breakpoint
UPDATE "inv_customer_returns"
   SET "approved_at" = "posted_at"
 WHERE "status" = 'POSTED' AND "approved_at" IS NULL AND "posted_at" IS NOT NULL;
--> statement-breakpoint
-- Item 3. "How much of this shipment has already come back" is asked on every
-- approval, and it is asked by source document. Without these it is a sequential
-- scan of every return the tenant has ever raised.
CREATE INDEX IF NOT EXISTS "idx_inv_cret_org_so"
  ON "inv_customer_returns" ("org_id", "so_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_cret_org_shipment"
  ON "inv_customer_returns" ("org_id", "shipment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_vret_org_grn"
  ON "inv_vendor_returns" ("org_id", "grn_id");
