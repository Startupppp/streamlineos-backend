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
 * B6 — what this order actually has in totes, per variant.
 *
 * Found through `inv_so_lines`, **not** through `inv_pick_lists.so_id`.
 *
 * A wave's header carries a null `so_id` — that is what distinguishes it from a
 * single-order pick — so the header lookup returned nothing for a wave-picked
 * order, and every quantity here came back zero. Reconciling a package against
 * zero picked units is not a strict check: `close` compared each package line
 * against a missing entry and refused nothing at all, because the map had no
 * key to compare against. Shipping had the identical defect and was fixed the
 * same way in B4.
 *
 * Every line still reaches this the same way for a single-order pick, which sets
 * both `so_id` and `so_line_id`. Cancelled pick lists are excluded, as they are
 * everywhere else this quantity is read.
 */
export async function pickedQuantities(
  db: DbOrTx,
  orgId: string,
  soId: number,
): Promise<QuantityByVariant> {
  const rows = await db.execute<{
    product_variant_id: number;
    quantity_picked: string;
  }>(sql`
    SELECT pll.product_variant_id,
           SUM(pll.quantity_picked)::text AS quantity_picked
      FROM inv_pick_list_lines pll
      JOIN inv_pick_lists pl
        ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
      JOIN inv_so_lines sol
        ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
     WHERE pll.org_id = ${orgId}
       AND sol.so_id = ${soId}
       AND pl.status <> 'CANCELLED'
     GROUP BY pll.product_variant_id
  `);

  const picked: QuantityByVariant = new Map();
  for (const row of rows)
    accumulate(picked, Number(row.product_variant_id), String(row.quantity_picked));
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
