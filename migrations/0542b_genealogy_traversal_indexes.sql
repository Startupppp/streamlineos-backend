-- 0542 — D1. The indexes a genealogy walk needs, and the ledger did not have.
--
-- `inv_stock_transactions` carried nine indexes and not one of them touched
-- `lot_id` or `serial_id`. Every lot-anchored read in this module —
-- `getLotDetail`'s movement list, the trace chain's event list, and now the
-- genealogy walk — filtered `org_id = ? AND lot_id = ?` against a table whose
-- only tenant-led indexes lead to variant, type, posting date or created_at, so
-- the planner's best option was a scan of the organisation's entire ledger. On a
-- tenant with a year of movements that is the whole point of the caps defeated
-- by the first query.
--
--   * idx_inv_txn_org_lot_reference     — "which documents did this lot move on"
--   * idx_inv_txn_org_serial_reference  — the same question for one unit
--   * idx_inv_txn_org_reference_item    — "which lots and serials moved on this
--                                          document", the fan-out half of the
--                                          walk. `idx_inv_txn_reference` already
--                                          covers (reference_type, reference_id)
--                                          but does NOT lead with org_id, and
--                                          §7 is explicit that an index on an
--                                          RLS table which does not supply
--                                          org_id can never serve an index-only
--                                          scan: the tenant qual is not
--                                          leakproof, so it is checked against
--                                          the heap tuple. The old index stays;
--                                          other callers use it.
--   * idx_inv_serials_org_lot           — `inv_serial_numbers.lot_id` is the one
--                                          real parent/child FK in this schema
--                                          and had no index at all, so walking
--                                          from a lot to its serials scanned
--                                          every serial in the tenant.
--
-- The reference indexes are partial on `lot_id IS NOT NULL` / `serial_id IS NOT
-- NULL`: most ledger rows carry neither, and excluding them keeps these indexes
-- a fraction of the table.
--
-- `quantity_change` and `correction_of_transaction_id` ride along as INCLUDE
-- payload so the walk's projection can be answered from the index. The walk
-- reads the movement's sign to decide the edge direction and its correction
-- link to decide whether the movement happened at all; without them every
-- matched index tuple would still need its heap page.
--
-- Locking notes, per §3 Migrations. `CREATE INDEX` takes SHARE on the table,
-- which blocks writes to `inv_stock_transactions` for the build. The
-- CONCURRENTLY form cannot be used: drizzle's runner wraps every pending
-- migration in one transaction and `CREATE INDEX CONCURRENTLY` may not appear
-- in a transaction block (see the header of 0533). `lock_timeout` makes a
-- contended build fail fast instead of queueing and blocking every writer
-- behind it. No constraint, column or type is added here, so there is nothing
-- to add NOT VALID and validate.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_txn_org_lot_reference"
  ON "inv_stock_transactions" ("org_id", "lot_id", "reference_type", "reference_id")
  INCLUDE ("id", "quantity_change", "correction_of_transaction_id")
  WHERE "lot_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_txn_org_serial_reference"
  ON "inv_stock_transactions" ("org_id", "serial_id", "reference_type", "reference_id")
  INCLUDE ("id", "quantity_change", "correction_of_transaction_id")
  WHERE "serial_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_txn_org_reference_item"
  ON "inv_stock_transactions" ("org_id", "reference_type", "reference_id", "lot_id", "serial_id")
  INCLUDE ("id", "quantity_change", "correction_of_transaction_id")
  WHERE "reference_type" IS NOT NULL AND ("lot_id" IS NOT NULL OR "serial_id" IS NOT NULL);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_serials_org_lot"
  ON "inv_serial_numbers" ("org_id", "lot_id")
  WHERE "lot_id" IS NOT NULL;
