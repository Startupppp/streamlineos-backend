import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * NEO-8 — which sales-order line a cross-docked receipt is holding stock for.
 *
 * The order is the only thing a receiving clerk knows: the receipt names
 * `crossDockSoId`, not a line. Shipping needs the line, because that is the
 * grain `postShipment` matches reservations at.
 *
 * The rule is "the first line for this product that is not already fully held",
 * so two deliveries against an order with two lines of the same SKU fill them
 * in order rather than both landing on the first. Null when the order has no
 * line for this product at all — a receipt cross-docked to an order that never
 * asked for it, which is a mistake nobody should silently repair.
 */
export async function resolveCrossDockSoLine(
  tx: Tx,
  orgId: string,
  soId: number,
  productVariantId: number,
): Promise<number | null> {
  const [row] = await tx.execute<{ id: number }>(sql`
    SELECT sol.id
      FROM inv_so_lines sol
     WHERE sol.org_id = ${orgId}
       AND sol.so_id = ${soId}
       AND sol.product_variant_id = ${productVariantId}
       AND sol.quantity > COALESCE((
             SELECT SUM(r.reserved_qty)
               FROM inv_stock_reservations r
              WHERE r.org_id = sol.org_id
                AND r.source_type = 'inv_sales_order'
                AND r.source_id = ${String(soId)}
                AND r.source_line_id = sol.id::text
                AND r.status = 'ACTIVE'
           ), 0)
     ORDER BY sol.id
     LIMIT 1
  `);
  return row ? Number(row.id) : null;
}

export type DiscrepancyReason = "SHORT" | "OVER" | "DAMAGED" | "WRONG_ITEM";

/** What a posting movement needs, assembled per line before the engine is called. */
export interface PendingMovement {
  transactionType: string;
  productVariantId: number;
  locationId: number;
  lotId: number | undefined;
  serialId: number | undefined;
  /** NEO-4 - the pallet the counter built this line onto, or null for loose. */
  handlingUnitId: number | null;
  /** NEO-11 - whose the goods are once they land. */
  ownership: "OWNED" | "VENDOR" | "CUSTOMER";
  quantityDelta: string;
  unitCost: string | undefined;
  /**
   * NEO-8. Take this movement's cost basis from an earlier one in the same
   * command, by index. A cross-dock's inbound leg is received at exactly what
   * leaving the dock consumed; estimating instead is exact under weighted
   * average and wrong under FIFO the moment an issue crosses a layer boundary.
   */
  costFromMovementIndex?: number;
}

/**
 * NEO-8 - the two legs that take a cross-docked line off the dock.
 *
 * An ordinary transfer pair, so the journey is as legible in the ledger as any
 * other move and the inbound leg inherits exactly what the receipt turned out
 * to cost. Empty for a line that is not cross-docked, which is most of them.
 *
 * The units never reach a storage bin, and `readReceiptGrains` therefore never
 * raises a putaway task for them: it sums the ledger at the receiving location
 * and keeps only positive remainders, and these net to zero there.
 */
export function buildCrossDockLegs(
  line: { crossDockSoId: number | null },
  receiptIndex: number,
  grain: {
    productVariantId: number;
    locationId: number;
    lotId: number | undefined;
    serialId: number | undefined;
    handlingUnitId: number | null;
    ownership: "OWNED" | "VENDOR" | "CUSTOMER";
    quantity: string;
    stagingLocationId: number | null;
  },
): PendingMovement[] {
  if (line.crossDockSoId === null || grain.stagingLocationId === null) return [];
  return [
    {
      transactionType: "TRANSFER_OUT",
      productVariantId: grain.productVariantId,
      locationId: grain.locationId,
      lotId: grain.lotId,
      serialId: grain.serialId,
      handlingUnitId: grain.handlingUnitId,
      ownership: grain.ownership,
      quantityDelta: `-${grain.quantity}`,
      unitCost: undefined,
    },
    {
      transactionType: "TRANSFER_IN",
      productVariantId: grain.productVariantId,
      locationId: grain.stagingLocationId,
      lotId: grain.lotId,
      serialId: grain.serialId,
      handlingUnitId: grain.handlingUnitId,
      ownership: grain.ownership,
      quantityDelta: grain.quantity,
      unitCost: undefined,
      costFromMovementIndex: receiptIndex,
    },
  ];
}
