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

/**
 * INV-10 — serialise the writers into a bin that records a capacity.
 *
 * `assertLocationCapacity` compares a bin's capacity against `SUM(on_hand)`
 * over *every* grain in it, but `lockLevels` locks only the grains the command
 * itself names. Two commands raising different lots of one product into the
 * same bin therefore take disjoint row locks, and under READ COMMITTED neither
 * aggregate can see the other's uncommitted row: both read a total under
 * capacity, both pass, and the bin commits over it. Measured at 120 units in a
 * 100-unit bin, on both the single and the batch path.
 *
 * Locking the *location* row closes it, because the capacity question is asked
 * per location and not per grain. Bins with no capacity recorded are the common
 * case and are deliberately not locked — unlimited storage must stay
 * contention-free — so this costs a row lock only where a limit exists to
 * enforce.
 *
 * Ordered by id in one statement for the same reason `lockLevels` is: a
 * command raising two capped bins must take them in the same order as every
 * other command, or two of them deadlock instead of queueing. Within a
 * transaction this always runs *after* `lockLevels`, so the global order is
 * levels then locations.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`, and the difference is not cosmetic.
 * `inv_stock_levels.location_id` is a foreign key, so the INSERT `lockLevels`
 * does for a grain that does not exist yet takes `FOR KEY SHARE` on the parent
 * location row. `FOR UPDATE` is the one mode `FOR KEY SHARE` conflicts with, so
 * two commands would each hold the parent's key-share lock and each wait for
 * the other to release it — measured as a `40P01` deadlock the first time this
 * was written that way, not as the queueing it looks like. `FOR NO KEY UPDATE`
 * conflicts with itself, which is the mutual exclusion this needs, and not with
 * `FOR KEY SHARE`, which is the FK traffic it must not block.
 */
export async function lockCapacityLocations(
  tx: Tx,
  orgId: string,
  locationIds: readonly number[],
): Promise<void> {
  const unique = [...new Set(locationIds)].sort((a, b) => a - b);
  if (unique.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM inv_locations
    WHERE org_id = ${orgId}
      AND id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
      AND capacity IS NOT NULL
    ORDER BY id
    FOR NO KEY UPDATE
  `);
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
