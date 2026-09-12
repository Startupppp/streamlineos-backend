import { sql, type SQL } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The one grain a reservation is against, and the one write that gives it back.
 *
 * Extracted verbatim when `ReservationService` was split for check:over-300, and
 * it is the reason the split is safe to make at all: this file is the seam. One
 * method in that service INCREMENTS `committed` and four give it back, and they
 * agree only because every one of them goes through the predicate below. The
 * doc on it says what happens when they stop agreeing — it has already happened
 * twice — so putting the predicate and `releaseCommitted` in one file that both
 * halves import, rather than in the file one half happens to live in, is the
 * whole point.
 */

export interface CommittedKey {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  /** NEO-4. The pallet, or null for loose. Part of the key for the same reason. */
  handlingUnitId: number | null;
  reservedQty: string;
}

/**
 * The grain a reservation is against, as one predicate both halves share.
 *
 * It is exported and shared because the asymmetry WAS the bug. The increment
 * found its row with one predicate and the release matched with another, and
 * the two drifted apart twice: first on `lot_id`, where releasing decremented
 * every lot at the location, and then on `ownership`, where it decremented the
 * consigned row standing at the same bin as the owned one. `GREATEST(0, ...)`
 * absorbed the over-subtraction both times, so reserved stock read as available
 * and could be promised twice, silently.
 *
 * `ownership = 'OWNED'` is a gate rather than a term, which is the kind this
 * module keeps forgetting — `availableQty` and `availableQtySql` both carry the
 * same one, with the same note: consigned stock is on hand and is not ours, and
 * forgetting it offers a supplier's goods for sale. `stock-projection.service`
 * added it (NEO-11); this path did not.
 *
 * @param alias the table's alias at the call site, or "" when it has none.
 */
export function committedGrainPredicate(
  orgId: string,
  grain: {
    productVariantId: number;
    locationId: number;
    lotId: number | null;
    serialId: number | null;
    handlingUnitId: number | null;
  },
  alias = "",
): SQL {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`
    ${col("org_id")} = ${orgId}
      AND ${col("product_variant_id")} = ${grain.productVariantId}
      AND ${col("location_id")} = ${grain.locationId}
      AND (${col("lot_id")} IS NOT DISTINCT FROM ${grain.lotId})
      AND (${col("serial_id")} IS NOT DISTINCT FROM ${grain.serialId})
      AND (${col("handling_unit_id")} IS NOT DISTINCT FROM ${grain.handlingUnitId})
      AND ${col("ownership")} = 'OWNED'
  `;
}

/** Releases committed on the SAME grain the reservation incremented. */
export async function releaseCommitted(tx: Tx, orgId: string, key: CommittedKey): Promise<void> {
  await tx.execute(sql`
    UPDATE inv_stock_levels
    SET committed = GREATEST(0, committed - ${key.reservedQty}::numeric)
    WHERE ${committedGrainPredicate(orgId, key)}
  `);
}
