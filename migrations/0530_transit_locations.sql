SET lock_timeout = '5s';
--> statement-breakpoint
-- A2. Goods in transit were nowhere.
--
-- A stock transfer posted TRANSFER_OUT at dispatch and TRANSFER_IN at
-- completion, and between the two the units sat on no stock level at all. The
-- org's total on-hand fell by the transferred quantity for the whole journey,
-- inventory valuation fell with it, and nothing anywhere told a planner that
-- 400 units were on a truck.
--
-- The vocabulary for the fix has been in the schema since it was written and
-- was read by nothing: `inv_location_type` has always carried a TRANSIT value
-- and `inv_locations` an `is_sellable` column. This migration is what puts them
-- to work -- one transit location per warehouse, non-sellable so availability
-- excludes it, non-pickable and non-receivable so no operator is offered it as
-- a destination, and uncapped so a large transfer is never refused by a
-- capacity rule on a waypoint.
--
-- `TransitLocationService` creates these on demand as well, so a warehouse
-- created after this migration still gets one. The backfill exists so that the
-- warehouses that already exist do not each pay for it on their first dispatch,
-- and so that the location is visible in the warehouse editor before anybody
-- dispatches anything.
--
-- Idempotent: `uniq_inv_locations_warehouse_code` is the uniqueness this wants,
-- and ON CONFLICT DO NOTHING against it makes a re-run a no-op.
INSERT INTO "inv_locations" (
  "org_id",
  "warehouse_id",
  "name",
  "code",
  "location_type",
  "is_pickable",
  "is_receivable",
  "is_sellable",
  "capacity",
  "is_active"
)
SELECT
  w."org_id",
  w."id",
  'In Transit',
  'TRANSIT',
  'TRANSIT'::"inv_location_type",
  false,
  false,
  false,
  NULL,
  true
FROM "inv_warehouses" w
ON CONFLICT ("warehouse_id", "code") DO NOTHING;
