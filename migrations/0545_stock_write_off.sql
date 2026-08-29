-- 0545 — D8. The write-off, as an adjustment rather than a second document.
--
-- A write-off is a stock adjustment with a reason and a negative quantity. It
-- already had a threshold, an approval status, maker-checker on approval and an
-- append-only ledger behind it; standing a parallel `inv_write_offs` document
-- beside that would have duplicated all four and left two ways for stock to
-- leave the building without a movement. So this adds what the adjustment was
-- missing rather than a new table:
--
--   * `SCRAP` as a reason. The ledger has had `SCRAP` as a transaction type
--     since 0000 and `inv_reason_category` has had it as a category; the
--     document's own reason enum did not, so condemning goods had to be
--     recorded as `DAMAGE` (why they are worthless) or `RECOUNT` (the count was
--     wrong) — neither of which says the units were destroyed.
--
--   * `scrap_location_id` — where the condemned goods physically went. It
--     carries no quantity on purpose. Moving the units into the scrap bin would
--     leave them on hand at that bin, still counted by every projection and
--     still valued, which is exactly what a write-off exists to stop; the
--     ledger movement is a SCRAP issue out of the line's own location and this
--     column records the disposal route beside it.
--
--   * `written_off_value` — what the write-off cost, from the cost layers the
--     issue actually consumed (`inv_valuation_consumptions`), not the variant's
--     list cost. Null until the document posts, because until then no layer has
--     been drawn.
--
-- The value threshold this unit routes on is `inv_settings
-- .adjustment_approval_value_threshold`, added by 0407 and read by nothing
-- since. No column is added for it here.
--
-- Shape notes, per backend/CLAUDE.md §3 Migrations:
--   * `lock_timeout` so this fails fast rather than queueing behind a long read
--     and blocking every write to `inv_stock_adjustments` behind it;
--   * no `CONCURRENTLY` — drizzle wraps all pending migrations in ONE
--     transaction and `CREATE INDEX CONCURRENTLY` cannot run inside one;
--   * the foreign key is `NOT VALID` then `VALIDATE`, because a bare
--     `ADD CONSTRAINT … FOREIGN KEY` takes ACCESS EXCLUSIVE on BOTH sides for
--     the whole validating scan, and one of those sides is `inv_locations`,
--     which every stock command reads;
--   * both columns are nullable, so no NOT NULL split is needed.
--
-- `ALTER TYPE … ADD VALUE` inside a transaction block is legal from PostgreSQL
-- 12 on, with one rule: the new label may not be *used* before the transaction
-- commits. Nothing below references 'SCRAP'.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Appended rather than ordered next to DAMAGE: this enum is not a lifecycle and
-- nothing sorts on it, and re-ordering an existing label is not possible anyway.
ALTER TYPE "inv_adj_reason" ADD VALUE IF NOT EXISTS 'SCRAP';
--> statement-breakpoint

ALTER TABLE "inv_stock_adjustments" ADD COLUMN IF NOT EXISTS "scrap_location_id" integer;
--> statement-breakpoint

ALTER TABLE "inv_stock_adjustments" ADD COLUMN IF NOT EXISTS "written_off_value" numeric(18, 4);
--> statement-breakpoint

-- The composite tenant key rather than a bare `scrap_location_id` reference: it
-- is what makes a cross-tenant scrap bin impossible relationally rather than
-- only by predicate, and it is the form every other inventory document uses.
-- `SET NULL` on delete, because retiring a bin must not destroy the record of a
-- write-off that went through it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_inv_stock_adjustments_scrap_location_id_org'
  ) THEN
    ALTER TABLE "inv_stock_adjustments"
      ADD CONSTRAINT "fk_inv_stock_adjustments_scrap_location_id_org"
      FOREIGN KEY ("org_id", "scrap_location_id")
      REFERENCES "inv_locations" ("org_id", "id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_stock_adjustments"
  VALIDATE CONSTRAINT "fk_inv_stock_adjustments_scrap_location_id_org";
--> statement-breakpoint

-- "Show me this month's write-offs" is the query the whole document exists for,
-- and without this it is a sequential scan of every adjustment the tenant has
-- ever raised. Leading with `org_id` because RLS adds
-- `org_id = app.current_org_id()` to every read of this table, so an index that
-- does not supply `org_id` cannot be used index-only at all.
CREATE INDEX IF NOT EXISTS "idx_inv_adj_org_reason"
  ON "inv_stock_adjustments" ("org_id", "reason", "created_at" DESC);
