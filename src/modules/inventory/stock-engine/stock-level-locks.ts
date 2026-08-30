import { sql } from "drizzle-orm";
import { invStockLevels } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface LevelGrain {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  /**
   * NEO-4 - the handling unit, or null for loose stock in the bin. Part of the
   * natural key, so a pallet's twelve and four loose on the same shelf are two
   * rows that stay tellable apart.
   */
  handlingUnitId: number | null;
  /**
   * NEO-11 - whose stock this is. Defaulted by the caller rather than optional,
   * so a new movement path has to say what it is posting: an omitted ownership
   * silently posting into the owned row is the failure mode this grain exists to
   * prevent.
   */
  ownership: "OWNED" | "VENDOR" | "CUSTOMER";
}

export interface LockedLevel {
  id: number;
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  handlingUnitId: number | null;
  ownership: "OWNED" | "VENDOR" | "CUSTOMER";
  onHand: string;
  committed: string;
  blockedQty: string;
  qualityHoldQty: string;
  averageCost: string | null;
}

interface LockedLevelRow extends Record<string, unknown> {
  id: number;
  product_variant_id: number;
  location_id: number;
  lot_id: number | null;
  serial_id: number | null;
  handling_unit_id: number | null;
  ownership: "OWNED" | "VENDOR" | "CUSTOMER";
  on_hand: string;
  committed: string;
  blocked_qty: string;
  quality_hold_qty: string;
  average_cost: string | null;
}

export function levelKey(grain: LevelGrain): string {
  return [
    grain.productVariantId,
    grain.locationId,
    grain.lotId ?? "null",
    grain.serialId ?? "null",
    grain.handlingUnitId ?? "null",
    grain.ownership,
  ].join(":");
}

/**
 * Deterministic ordering for both the create and the lock.
 *
 * The lock order is what prevents a deadlock, but the create order matters too:
 * a grain that does not exist yet is inserted before it can be locked, and an
 * INSERT takes its own row lock. Two commands inserting the same new grains in
 * caller order would deadlock on the insert while never reaching the ordered
 * SELECT. Sorting by the natural key fixes both, and it is available before the
 * rows have ids.
 */
function byNaturalKey(a: LevelGrain, b: LevelGrain): number {
  return (
    a.productVariantId - b.productVariantId ||
    a.locationId - b.locationId ||
    (a.lotId ?? 0) - (b.lotId ?? 0) ||
    (a.serialId ?? 0) - (b.serialId ?? 0) ||
    (a.handlingUnitId ?? 0) - (b.handlingUnitId ?? 0) ||
    a.ownership.localeCompare(b.ownership)
  );
}

/**
 * Creates any missing stock rows, then locks every requested grain in one
 * statement ordered by primary key.
 *
 * The single-command path used to lock rows as its movement loop reached them,
 * so the order was whatever the caller happened to send. Two concurrent
 * multi-line commands over the same rows in opposite order deadlock, and the
 * loser surfaces as a 500 rather than a retryable conflict. The batch path
 * already ordered its lock; this makes both paths use the same one.
 */
export async function lockLevels(
  tx: Tx,
  orgId: string,
  grains: readonly LevelGrain[],
): Promise<Map<string, LockedLevel>> {
  const unique = new Map<string, LevelGrain>();
  for (const grain of grains) if (!unique.has(levelKey(grain))) unique.set(levelKey(grain), grain);
  const ordered = [...unique.values()].sort(byNaturalKey);
  if (ordered.length === 0) return new Map();

  for (const grain of ordered) {
    await tx
      .insert(invStockLevels)
      .values({
        orgId,
        productVariantId: grain.productVariantId,
        locationId: grain.locationId,
        lotId: grain.lotId,
        serialId: grain.serialId,
        handlingUnitId: grain.handlingUnitId,
        ownership: grain.ownership,
        onHand: "0",
        committed: "0",
        onOrder: "0",
        blockedQty: "0",
        qualityHoldQty: "0",
        outgoingQty: "0",
      })
      .onConflictDoNothing();
  }

  const predicate = sql.join(
    ordered.map(
      (grain) =>
        sql`(product_variant_id = ${grain.productVariantId} AND location_id = ${grain.locationId} AND (lot_id IS NOT DISTINCT FROM ${grain.lotId}) AND (serial_id IS NOT DISTINCT FROM ${grain.serialId}) AND (handling_unit_id IS NOT DISTINCT FROM ${grain.handlingUnitId}) AND ownership = ${grain.ownership})`,
    ),
    sql` OR `,
  );

  const rows = await tx.execute<LockedLevelRow>(sql`
    SELECT id, product_variant_id, location_id, lot_id, serial_id, handling_unit_id, ownership,
           on_hand, committed, blocked_qty, quality_hold_qty, average_cost
    FROM inv_stock_levels
    WHERE org_id = ${orgId}
      AND (${predicate})
    ORDER BY id
    FOR UPDATE
  `);

  const locked = new Map<string, LockedLevel>();
  for (const row of rows) {
    const level: LockedLevel = {
      id: row.id,
      productVariantId: row.product_variant_id,
      locationId: row.location_id,
      lotId: row.lot_id,
      serialId: row.serial_id,
      handlingUnitId: row.handling_unit_id,
      ownership: row.ownership,
      onHand: row.on_hand,
      committed: row.committed,
      blockedQty: row.blocked_qty ?? "0",
      qualityHoldQty: row.quality_hold_qty ?? "0",
      averageCost: row.average_cost,
    };
    locked.set(levelKey(level), level);
  }
  return locked;
}
