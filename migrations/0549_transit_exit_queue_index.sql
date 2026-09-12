-- 0549 — R3. The index behind the stranded-transit queue.
--
-- A2 gave every warehouse a `TRANSIT` location and made a dispatch park its
-- goods there, so stock on a van is on hand, unsellable and countable. What it
-- did not give was a way out: a short receipt takes only what arrived off the
-- transit bin and leaves the difference standing for ever, and `cancelTransfer`
-- stops at RESERVED. R3 adds the exit command (`POST
-- /inventory/stock/transit/exit`, gated on `inventory:transit:abandon`) and the
-- queue it acts on (`GET /inventory/stock/transit/stranded`).
--
-- The queue is anchored on the transfer rather than on `inv_stock_levels`,
-- because "which document put this here" is the question the command needs
-- answered and a stock level cannot answer it — one transit location serves a
-- whole warehouse, so several dispatches' goods share a bin at a grain that
-- names no document. So the driving scan is:
--
--   WHERE org_id = ? AND dispatched_at IS NOT NULL
--     AND status IN ('IN_TRANSIT', 'COMPLETED')
--   ORDER BY dispatched_at DESC, id DESC
--
-- `idx_inv_transfers_org_status` is `(org_id, status)`. It answers the filter
-- and nothing else: every completed transfer an organisation has ever made
-- matches `status = 'COMPLETED'`, so the queue's first page costs a sort of the
-- whole history. This index carries the sort columns and restricts itself with
-- the same predicate the query uses, so it holds only transfers that actually
-- went through transit — a small fraction of the table, and the only rows the
-- queue can ever return.
--
-- Leading with `org_id` per §7: the RLS policy adds `org_id =
-- app.current_org_id()`, which is not leakproof, so an index that does not
-- supply `org_id` itself can never give an index-only scan and the planner
-- tends to refuse it outright.
--
-- No table or column is added, so nothing here changes what `db/schema` must
-- declare. `CREATE INDEX CONCURRENTLY` cannot appear inside a transaction block
-- and drizzle's runner wraps every pending migration in one, so this is the
-- plain form; the partial predicate keeps the build to the in-transit slice.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_transfers_org_transit_queue"
  ON "inv_stock_transfers" ("org_id", "dispatched_at" DESC, "id" DESC)
  WHERE "dispatched_at" IS NOT NULL
    AND "status" IN ('IN_TRANSIT', 'COMPLETED');
--> statement-breakpoint

-- The other half of the same scan: from a transfer in the queue to the lines
-- that dispatched more than they received. `idx_inv_transfer_lines_transfer` is
-- `(transfer_id)` alone, which under RLS cannot serve an index-only scan for the
-- reason above, and the shortfall predicate is what makes most lines irrelevant.
CREATE INDEX IF NOT EXISTS "idx_inv_transfer_lines_org_short"
  ON "inv_stock_transfer_lines" ("org_id", "transfer_id")
  WHERE "quantity" > COALESCE("quantity_received", 0);
