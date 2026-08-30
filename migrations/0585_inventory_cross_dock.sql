-- NEO-8 -- the cross-dock path.
--
-- Cross-docking is "this pallet is not for the shelf, it is for that lorry". Set
-- on the *line* rather than the header because one delivery routinely has a few
-- lines going straight back out and the rest going to storage, and a header flag
-- would force the receiver to split the delivery to say so.
--
-- A cross-docked line is received at the dock like any other and then moved to
-- outbound staging inside the same posting: two more engine movements, under the
-- same idempotency key family, with the inbound leg inheriting exactly what the
-- receipt turned out to cost. It is an ordinary transfer pair, so the journey is
-- as legible in the ledger as any other move.
--
-- The units never reach a storage bin, and no putaway task is raised for them --
-- not by a flag, but by construction: `readReceiptGrains` sums the ledger at the
-- receiving location and keeps only positive remainders, and a cross-docked
-- grain nets to zero there.
--
-- They are also reserved to the order that pulled them across, so they are never
-- offered to the next customer to ask. Without that they would sit at a pickable
-- staging location as ordinary free stock.
--
-- Nullable, additive, no backfill: every existing line is not cross-docked, which
-- is what NULL means.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "cross_dock_so_id" integer;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "inv_grn_lines_cross_dock_so_id_fk"
    FOREIGN KEY ("cross_dock_so_id") REFERENCES "inv_sales_orders"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "inv_grn_lines_cross_dock_so_id_fk";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_grn_lines_org_cross_dock"
  ON "inv_grn_lines" ("org_id", "cross_dock_so_id") WHERE "cross_dock_so_id" IS NOT NULL;
