import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { cmpDec } from "../stock-engine/decimal";
import type { ReservationService } from "../stock-engine/reservation.service";
import { loadOrderableVariants } from "../products/lib/orderable-variants";
import type { PickGrain } from "./pick-line";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Where the org's records place the stock a substitution is about to promise. */
export interface SubstituteGrain {
  locationId: number;
  lotId: number | null;
}

/** What a demand rewrite actually moved, for the audit row and the recompute. */
export interface DemandRewrite {
  releasedReservationIds: number[];
  newReservationId: number | null;
  /** Every projection row whose `outgoing_qty` the caller must now recompute. */
  grains: PickGrain[];
}

/**
 * B5, item 3 — a substitution has to be UOM-compatible, and this is why.
 *
 * The sales-order line carries a bare `quantity`, and what that number counts is
 * the product's unit of measure. Swapping a SKU sold by the kilogram for one
 * sold by the each leaves "5" on the line meaning something it did not mean a
 * moment ago, and every downstream reader — the reservation, the picker's task,
 * the invoice — reads the new meaning off the old number. Nothing throws; the
 * customer is simply sent five of the wrong size of thing.
 *
 * Compared on the *product's* stocking UOM rather than the line's selling UOM,
 * because the stocking UOM is what `quantity` is stored in and what every stock
 * row is counted in. Two products with no UOM at all are compatible: an
 * unmeasured catalogue is the common case and means "each" by default on both
 * sides.
 */
async function assertUomCompatible(
  db: Db,
  orgId: string,
  originalProductId: number,
  substituteProductId: number,
): Promise<void> {
  if (originalProductId === substituteProductId) return;

  const rows = await db.execute<{ id: number; uom_id: number | null; sku: string }>(sql`
    SELECT id, uom_id, sku FROM inv_products
     WHERE org_id = ${orgId} AND id IN (${originalProductId}, ${substituteProductId})
  `);
  const original = rows.find((r) => Number(r.id) === originalProductId);
  const substitute = rows.find((r) => Number(r.id) === substituteProductId);
  const originalUom = original?.uom_id ?? null;
  const substituteUom = substitute?.uom_id ?? null;

  if (originalUom !== substituteUom) {
    throw new BadRequestException(
      `${substitute?.sku ?? "That product"} is not measured in the same unit as ${original?.sku ?? "the ordered product"}, so the ordered quantity would not mean the same thing`,
    );
  }
}

/**
 * The catalogue and measurement gates a substitution has to pass, together.
 *
 * `loadOrderableVariants` is the same gate a sales-order line is held to — a
 * discontinued, archived or deleted SKU may not be introduced at the shelf
 * either, or the shelf becomes a route around the catalogue. The UOM check is
 * the half that is specific to swapping one line's product for another.
 */
export async function assertSubstitutable(
  db: Db,
  orgId: string,
  originalVariantId: number,
  substituteVariantId: number,
): Promise<void> {
  if (originalVariantId === substituteVariantId) {
    throw new BadRequestException("A substitution has to name a different product");
  }
  const variants = await loadOrderableVariants(db, orgId, [
    originalVariantId,
    substituteVariantId,
  ]);
  await assertUomCompatible(
    db,
    orgId,
    variants.get(originalVariantId)!.productId,
    variants.get(substituteVariantId)!.productId,
  );
}

/**
 * How much of this sales-order line is already in a tote, across every
 * non-cancelled pick list.
 *
 * A line picked partly by a wave and partly by a single-order pick is legitimate,
 * so the question is never "how much did *this* pick list take".
 */
export async function pickedAgainstSoLine(
  tx: Tx,
  orgId: string,
  soLineId: number,
): Promise<string> {
  const [row] = await tx.execute<{ picked: string }>(sql`
    SELECT COALESCE(SUM(pll.quantity_picked::numeric), 0)::text AS picked
      FROM inv_pick_list_lines pll
      JOIN inv_pick_lists pl
        ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
     WHERE pll.org_id = ${orgId}
       AND pll.so_line_id = ${soLineId}
       AND pl.status <> 'CANCELLED'
  `);
  return row?.picked ?? "0";
}

/** The sales-order line a substitution is about to rewrite. */
export interface SoLineDemand {
  id: number;
  soId: number;
  productVariantId: number;
  quantity: string;
  warehouseId: number | null;
}

export async function loadSoLineDemand(
  tx: Tx,
  orgId: string,
  soLineId: number,
): Promise<SoLineDemand | null> {
  const [row] = await tx.execute<{
    id: number;
    so_id: number;
    product_variant_id: number;
    quantity: string;
    warehouse_id: number | null;
  }>(sql`
    SELECT sol.id, sol.so_id, sol.product_variant_id, sol.quantity, so.warehouse_id
      FROM inv_so_lines sol
      JOIN inv_sales_orders so ON so.org_id = sol.org_id AND so.id = sol.so_id
     WHERE sol.org_id = ${orgId} AND sol.id = ${soLineId}
  `);
  if (!row) return null;
  return {
    id: Number(row.id),
    soId: Number(row.so_id),
    productVariantId: Number(row.product_variant_id),
    quantity: String(row.quantity),
    warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
  };
}

/**
 * Releases every ACTIVE reservation standing behind a sales-order line.
 *
 * **This is B5's "Done when", and the defect it closes.** `reportException` used
 * to record the shortfall and stop, leaving the reservation holding the units
 * that were never picked: `committed` stayed at the full ordered quantity while
 * `EXPECTED_OUTGOING` — which subtracts the whole remaining `committed` —
 * clamped to zero, so a five-unit line short-picked at two took *five* units out
 * of availability and gave three of them back to nobody, permanently. The stock
 * was on the shelf and no other customer could be sold it.
 *
 * Whole reservations, not the unpicked part of one. That is forced by the same
 * arithmetic that forces `consumeCoveredReservations` to be all-or-nothing: the
 * outgoing term subtracts the entire remaining `committed` at the grain, so a
 * partial release would drop `committed` by the released part while the outgoing
 * term stayed clamped at zero, and availability would rise by units standing in
 * a tote. Released in full, the recompute reads `picked - 0` and picks the toted
 * units straight back up — so the two units in the tote stay out of availability
 * through `outgoing_qty` and only the three on the shelf come back.
 *
 * Ordered and locked `FOR UPDATE` through `releaseReservationInTx`, which is a
 * no-op on a row that is no longer ACTIVE — so a concurrent consume and this
 * release cannot both subtract the same `committed`.
 *
 * Returns the grains those reservations sat on, because their `outgoing_qty` has
 * to be recomputed too: the reservation's bin is not necessarily the one the
 * picker took the goods from.
 */
export async function releaseSoLineReservations(
  tx: Tx,
  orgId: string,
  userId: string,
  soLineId: number,
  reservations: ReservationService,
): Promise<{ ids: number[]; grains: PickGrain[] }> {
  const rows = await tx.execute<{ id: number }>(sql`
    SELECT id FROM inv_stock_reservations
     WHERE org_id = ${orgId}
       AND source_type = 'inv_sales_order'
       AND source_line_id = ${String(soLineId)}
       AND status = 'ACTIVE'
     ORDER BY id
  `);

  const ids: number[] = [];
  const grains: PickGrain[] = [];
  for (const row of rows) {
    const released = await reservations.releaseReservationInTx(
      tx,
      orgId,
      userId,
      Number(row.id),
    );
    if (!released) continue;
    ids.push(released.id);
    if (released.locationId !== null) {
      grains.push({
        productVariantId: released.productVariantId,
        locationId: released.locationId,
        lotId: released.lotId,
        serialId: released.serialId,
        handlingUnitId: released.handlingUnitId,
      });
    }
  }
  return { ids, grains };
}

/**
 * B5, item 3 — "rewrites SO line identity and reservation", in one place.
 *
 * The decision this encodes, and the one it refuses to make:
 *
 * **What moves.** The sales-order line's `product_variant_id` becomes the
 * substitute. That is the whole meaning of "rewrites demand": from here on the
 * order is for the thing that is actually going to leave the building, so
 * `shipSo` issues the substitute, the invoice names it, and availability holds
 * it. Leaving the line naming the original meant every downstream reader was
 * looking at a SKU nobody was going to send.
 *
 * **What does not.** `unit_price`, `quantity`, `tax_rate`, `amount` and the
 * order's totals are untouched. Repricing a customer's order is a commercial act
 * and a picker at a shelf is not the person who takes it — a substitution is the
 * warehouse saying "we will honour this line with that item", not a renegotiation.
 * `cost_at_time` is left alone for the same reason in reverse: it records what the
 * line was costed at when it was taken, and the ledger's own movement costing
 * prices what actually ships, so rewriting it would create a second, disagreeing
 * answer to the same question.
 *
 * **One reservation, on the new SKU.** The original's reservations are released —
 * that stock is back on the shelf and genuinely available, because this order no
 * longer wants it — and exactly one is created against the substitute at the
 * grain the shared allocator resolves. Creating before releasing would be the
 * same double-subtraction trap the confirm path documents; releasing first means
 * the two SKUs are never both held at once.
 *
 * The grain comes from `findAvailableLotForLine`, the same FEFO/FIFO helper a
 * sales-order reserve and a wave allocation use, rather than from the picker.
 * Two reasons: it has already applied the one availability formula, so the
 * reservation it feeds cannot fail on insufficient stock and roll the whole
 * report back; and a private "where is this SKU" query in this file is exactly
 * the second allocator that once had picking promising expired lots.
 */
export async function rewriteSoLineDemand(
  tx: Tx,
  orgId: string,
  userId: string,
  args: {
    soLineId: number;
    fromVariantId: number;
    toVariantId: number;
    quantity: string;
    grain: SubstituteGrain;
    soId: number;
    warehouseId: number | null;
  },
  reservations: ReservationService,
): Promise<DemandRewrite> {
  const released = await releaseSoLineReservations(
    tx,
    orgId,
    userId,
    args.soLineId,
    reservations,
  );

  await tx.execute(sql`
    UPDATE inv_so_lines
       SET product_variant_id = ${args.toVariantId}
     WHERE org_id = ${orgId}
       AND id = ${args.soLineId}
       AND product_variant_id = ${args.fromVariantId}
  `);

  const reservation = await reservations.createReservationInTx(tx, orgId, userId, {
    sourceType: "inv_sales_order",
    sourceId: String(args.soId),
    sourceLineId: String(args.soLineId),
    productVariantId: args.toVariantId,
    warehouseId: args.warehouseId ?? undefined,
    locationId: args.grain.locationId,
    lotId: args.grain.lotId ?? undefined,
    qty: args.quantity,
  });

  return {
    releasedReservationIds: released.ids,
    newReservationId: reservation.id,
    grains: [
      ...released.grains,
      {
        productVariantId: args.toVariantId,
        locationId: args.grain.locationId,
        lotId: args.grain.lotId,
        serialId: null,
        // A substitute is a different SKU, so it is not on the pallet the
        // original came off: it is picked loose from the bin the substitution
        // resolved to.
        handlingUnitId: null,
      },
    ],
  };
}

/**
 * The bound a substitution is held to, as a value rather than three `if`s spread
 * across the service.
 *
 * A substitution rewrites the line's identity, and an identity is not divisible:
 * a line half-picked as the original and half-substituted would have to become
 * two lines with two prices, which is a commercial decision nobody at a shelf
 * takes. So the substitute has to cover the line's whole demand and none of the
 * original may already be in a tote. A picker facing the partial case confirms
 * what they found and raises `SHORT` for the rest, which is what those two
 * facilities are for.
 */
export function assertSubstitutionCoversLine(
  substituteQuantity: string,
  alreadyPicked: string,
  soLineQuantity: string,
): void {
  if (cmpDec(alreadyPicked, "0") > 0) {
    throw new BadRequestException(
      `${alreadyPicked} of the ordered product is already in a tote, so this line cannot be swapped wholesale — confirm what you found and raise a shortfall for the rest`,
    );
  }
  if (cmpDec(substituteQuantity, soLineQuantity) !== 0) {
    throw new BadRequestException(
      `A substitution has to cover the whole line: this order asks for ${soLineQuantity}`,
    );
  }
}
