import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import { addDec, cmpDec, subDec } from "../stock-engine/decimal";

/** A quantity per variant, exact. Never a float: see `stock-engine/decimal.ts`. */
export type QuantityByVariant = Map<number, string>;

export interface ReconciliationLine {
  productVariantId: number;
  quantity: string;
}

function accumulate(
  into: QuantityByVariant,
  variantId: number,
  quantity: string,
): void {
  into.set(variantId, addDec(into.get(variantId) ?? "0", quantity));
}

/**
 * B7 — one row for every distinct thing standing in this order's totes, at the
 * grain it stands on.
 *
 * This is the single answer to "what came off the shelf for this order", and
 * packing, shipping and the reconciliation above all read it. Three commands
 * carried three hand-copied versions of the same join, which is how the
 * substitution below stayed invisible in two of them.
 *
 * **A pick line can yield two rows, and that is the point.** A picker who swaps
 * one SKU for another records the swap on `substitute_variant_id` /
 * `substitute_quantity` and leaves `quantity_picked` at zero, because that
 * column means how much of *this line's own* variant was picked and B5 was
 * right to keep it that way — `pickedAgainstSoLine`, the second-substitution
 * guard and `consumeCoveredReservations` all read it with that meaning. So the
 * substitute is a *second* row here rather than a rewrite of the first, exactly
 * as `EXPECTED_OUTGOING` already treats it: same pick line, same bin, different
 * variant and quantity. Reading only `quantity_picked` is why a mixed order —
 * some lines picked, one substituted — shipped everything except the swapped
 * line and went out PARTIALLY_SHIPPED.
 *
 * Found through `inv_so_lines`, **not** through `inv_pick_lists.so_id`. A wave's
 * header carries a null `so_id` — that is what distinguishes it from a
 * single-order pick — so a header lookup returns nothing for a wave-picked
 * order. Every line still arrives the same way for a single-order pick, which
 * sets both. Cancelled pick lists are excluded, as they are everywhere else this
 * quantity is read.
 *
 * Zero-quantity rows are kept rather than filtered: a line closed by an
 * exception holds nothing, but its grain still has to be recomputed when the
 * order ships, and a caller that wants only movable units says so itself.
 */
export interface ShelfLine {
  pickLineId: number;
  soLineId: number;
  /** The variant actually in the tote — the substitute, where one went in. */
  productVariantId: number;
  locationId: number | null;
  lotId: number | null;
  serialId: number | null;
  quantity: string;
  substituted: boolean;
}

export async function shelfLines(
  db: DbOrTx,
  orgId: string,
  soId: number,
): Promise<ShelfLine[]> {
  const rows = await db.execute<{
    pick_line_id: number;
    so_line_id: number;
    product_variant_id: number;
    location_id: number | null;
    lot_id: number | null;
    serial_id: number | null;
    quantity: string;
    substituted: boolean;
  }>(sql`
    SELECT pll.id            AS pick_line_id,
           pll.so_line_id    AS so_line_id,
           pll.product_variant_id,
           pll.location_id,
           pll.lot_id,
           pll.serial_id,
           pll.quantity_picked::text AS quantity,
           false             AS substituted
      FROM inv_pick_list_lines pll
      JOIN inv_pick_lists pl
        ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
      JOIN inv_so_lines sol
        ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
     WHERE pll.org_id = ${orgId}
       AND sol.so_id = ${soId}
       AND pl.status <> 'CANCELLED'
    UNION ALL
    SELECT pll.id,
           pll.so_line_id,
           pll.substitute_variant_id,
           pll.location_id,
           pll.lot_id,
           pll.serial_id,
           pll.substitute_quantity::text,
           true
      FROM inv_pick_list_lines pll
      JOIN inv_pick_lists pl
        ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
      JOIN inv_so_lines sol
        ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
     WHERE pll.org_id = ${orgId}
       AND sol.so_id = ${soId}
       AND pl.status <> 'CANCELLED'
       AND pll.substitute_variant_id IS NOT NULL
       AND COALESCE(pll.substitute_quantity, 0)::numeric <> 0
     ORDER BY pick_line_id, substituted
  `);

  return rows.map((row) => ({
    pickLineId: Number(row.pick_line_id),
    soLineId: Number(row.so_line_id),
    productVariantId: Number(row.product_variant_id),
    locationId: row.location_id === null ? null : Number(row.location_id),
    lotId: row.lot_id === null ? null : Number(row.lot_id),
    serialId: row.serial_id === null ? null : Number(row.serial_id),
    quantity: String(row.quantity),
    substituted: row.substituted === true,
  }));
}

/**
 * B6 — what this order actually has in totes, per variant.
 *
 * The per-variant view of `shelfLines`, so packing and shipping cannot disagree
 * about what came off the shelf. It used to be its own copy of the join reading
 * `quantity_picked` alone, which meant a substituted order reconciled against a
 * picked figure of zero for the SKU actually in the carton — `assertWithinPicked`
 * then refused to pack the very units the picker had put there.
 */
export async function pickedQuantities(
  db: DbOrTx,
  orgId: string,
  soId: number,
): Promise<QuantityByVariant> {
  const picked: QuantityByVariant = new Map();
  for (const line of await shelfLines(db, orgId, soId))
    accumulate(picked, line.productVariantId, line.quantity);
  return picked;
}

/**
 * What is already in this order's cartons, per variant.
 *
 * Across **every** package standing against the order, not just the one being
 * written to. An order packed into three cartons is over-packed the moment the
 * three together exceed what was picked, and a per-carton check cannot see that
 * — it would wave through three cartons each holding the whole order.
 *
 * `excludePackageId` leaves one package out, for the caller that is about to
 * replace its contents wholesale.
 */
export async function packedQuantities(
  db: DbOrTx,
  orgId: string,
  soId: number,
  excludePackageId?: number,
): Promise<QuantityByVariant> {
  const rows = await db.execute<{
    product_variant_id: number;
    quantity: string;
  }>(sql`
    SELECT pkl.product_variant_id,
           SUM(pkl.quantity)::text AS quantity
      FROM inv_package_lines pkl
      JOIN inv_packages pkg
        ON pkg.org_id = pkl.org_id AND pkg.id = pkl.package_id
     WHERE pkl.org_id = ${orgId}
       AND pkg.so_id = ${soId}
       ${excludePackageId === undefined ? sql`` : sql`AND pkg.id <> ${excludePackageId}`}
     GROUP BY pkl.product_variant_id
  `);

  const packed: QuantityByVariant = new Map();
  for (const row of rows)
    accumulate(packed, Number(row.product_variant_id), String(row.quantity));
  return packed;
}

/**
 * Refuses contents that exceed what was picked.
 *
 * Exact. Deciding that a package holds no more than was picked on the strength
 * of float comparisons is how a parcel goes out with one unit more than anybody
 * picked. A variant nobody picked at all has a picked figure of zero, so it is
 * refused by the same comparison rather than by a separate branch — packing a
 * SKU that never came off a shelf is the same defect as packing too many of one
 * that did.
 */
export function assertWithinPicked(
  picked: QuantityByVariant,
  packed: QuantityByVariant,
): void {
  for (const [variantId, quantity] of packed) {
    const available = picked.get(variantId) ?? "0";
    if (cmpDec(available, quantity) < 0)
      throw new BadRequestException(INV_ERRORS.PACKAGE_CONTENT_MISMATCH);
  }
}

/** What is still owed to the cartons, per variant, never negative. */
export function outstandingQuantities(
  picked: QuantityByVariant,
  packed: QuantityByVariant,
): QuantityByVariant {
  const outstanding: QuantityByVariant = new Map();
  for (const [variantId, quantity] of picked) {
    const already = packed.get(variantId) ?? "0";
    if (cmpDec(quantity, already) > 0)
      outstanding.set(variantId, subDec(quantity, already));
  }
  return outstanding;
}

/** The whole map as one figure, for a queue row that only shows progress. */
export function totalOf(quantities: QuantityByVariant): string {
  let total = "0";
  for (const quantity of quantities.values()) total = addDec(total, quantity);
  return total;
}

export function toReconciliationLines(
  quantities: QuantityByVariant,
): ReconciliationLine[] {
  return [...quantities]
    .map(([productVariantId, quantity]) => ({ productVariantId, quantity }))
    .sort((a, b) => a.productVariantId - b.productVariantId);
}
