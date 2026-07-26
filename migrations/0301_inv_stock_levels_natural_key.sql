-- Introduce a true natural-key unique index on inv_stock_levels so that
-- INSERT ... ON CONFLICT DO NOTHING correctly deduplicates stock rows.
--
-- COALESCE(lot_id, 0) and COALESCE(serial_id, 0) are safe sentinels:
-- lot_id and serial_id are FKs to serial (integer) PKs on their parent tables,
-- which start at 1, so 0 is never a valid id. Using 0 as the "no lot / no serial"
-- sentinel collapses all NULL values into a single bucket per (org, variant, location),
-- preventing phantom duplicates while still allowing distinct lot or serial rows.

-- Step 1: Deduplicate any phantom rows that accumulated before this index was in place.
-- For each natural-key group keep the MIN(id) survivor; add the qty columns from all
-- duplicates into it; preserve average_cost from the survivor row.
WITH survivors AS (
  SELECT
    MIN(id) AS survivor_id,
    org_id,
    product_variant_id,
    location_id,
    COALESCE(lot_id, 0)    AS lot_bucket,
    COALESCE(serial_id, 0) AS serial_bucket
  FROM inv_stock_levels
  GROUP BY org_id, product_variant_id, location_id, COALESCE(lot_id, 0), COALESCE(serial_id, 0)
),
aggregated AS (
  SELECT
    s.survivor_id,
    SUM(sl.on_hand)           AS total_on_hand,
    SUM(sl.committed)         AS total_committed,
    SUM(sl.on_order)          AS total_on_order,
    SUM(sl.blocked_qty)       AS total_blocked_qty,
    SUM(sl.quality_hold_qty)  AS total_quality_hold_qty,
    SUM(sl.outgoing_qty)      AS total_outgoing_qty
  FROM survivors s
  JOIN inv_stock_levels sl
    ON  sl.org_id              = s.org_id
    AND sl.product_variant_id  = s.product_variant_id
    AND sl.location_id         = s.location_id
    AND COALESCE(sl.lot_id,    0) = s.lot_bucket
    AND COALESCE(sl.serial_id, 0) = s.serial_bucket
  GROUP BY s.survivor_id
  HAVING COUNT(*) > 1
)
UPDATE inv_stock_levels sl
SET
  on_hand          = a.total_on_hand,
  committed        = a.total_committed,
  on_order         = a.total_on_order,
  blocked_qty      = a.total_blocked_qty,
  quality_hold_qty = a.total_quality_hold_qty,
  outgoing_qty     = a.total_outgoing_qty
FROM aggregated a
WHERE sl.id = a.survivor_id;

-- Step 2: Delete the non-surviving duplicate rows.
DELETE FROM inv_stock_levels
WHERE id NOT IN (
  SELECT MIN(id)
  FROM inv_stock_levels
  GROUP BY org_id, product_variant_id, location_id, COALESCE(lot_id, 0), COALESCE(serial_id, 0)
);

-- Step 3: Drop the old non-unique composite index.
DROP INDEX IF EXISTS idx_inv_stock_levels_org_variant_loc;

-- Step 4: Create the new unique natural-key index.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_stock_levels_natural_key
  ON inv_stock_levels (org_id, product_variant_id, location_id, (COALESCE(lot_id, 0)), (COALESCE(serial_id, 0)));
