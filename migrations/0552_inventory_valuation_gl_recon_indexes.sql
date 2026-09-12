-- 0552 — D5/D6. The two access paths a dated valuation and a GL reconciliation
-- need, and the ledger did not have.
--
-- Both new reports ask a question `inv_stock_transactions` has never been asked
-- before: "what happened in this organisation between these two dates". The
-- table carries an index on `(org_id, posting_date)`, but `posting_date` is
-- nullable and both reports fall back to `created_at` when it is unset, so the
-- predicate they actually write is
--
--     COALESCE(posting_date, created_at::date) BETWEEN ? AND ?
--
-- which no plain column index can serve. Splitting it into an OR of two
-- indexable branches is the alternative and is worse: §7 is explicit that an OR
-- between an indexed predicate and anything else defeats both, and the row that
-- would land in each branch is decided per row.
--
-- `created_at` is `timestamp without time zone`, so `created_at::date` is
-- IMMUTABLE and may be indexed. `org_id` leads, because under RLS the tenant
-- qual is not leakproof and is evaluated against the heap tuple unless the index
-- supplies `org_id` itself — an index that omits it is refused outright rather
-- than merely unhelpful (§7).
--
-- The INCLUDE payload is what each report projects. The reconciliation groups by
-- `(reference_type, reference_id)` and sums `total_cost`; the as-at valuation
-- groups by `product_variant_id` and sums `quantity_change`; both filter
-- `quantity_bucket = 'ON_HAND'`. Carrying all five keeps a bounded window
-- answerable index-only instead of visiting a heap page per movement.
--
-- The consumption index is the other half of the as-at valuation. Replaying a
-- layer's remaining quantity on a past date reads every consumption against that
-- layer up to the date; `idx_inv_val_consumptions_org_layer` stops at the layer,
-- so the date filter and the `quantity` sum were both heap work.
--
-- Locking, per §3. `CREATE INDEX` takes SHARE and blocks writes for the build;
-- the CONCURRENTLY form cannot be used because drizzle's runner wraps every
-- pending migration in one transaction. `lock_timeout` makes a contended build
-- fail fast rather than queue and block every writer behind it. Additive only —
-- no table, column, constraint or type is created, altered or dropped.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_txn_org_effective_date"
  ON "inv_stock_transactions" ("org_id", (COALESCE("posting_date", ("created_at")::date)))
  INCLUDE ("id", "product_variant_id", "reference_type", "reference_id", "quantity_change", "total_cost", "quantity_bucket");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_val_consumptions_org_layer_created"
  ON "inv_valuation_consumptions" ("org_id", "valuation_layer_id", "created_at")
  INCLUDE ("quantity", "total_cost");
