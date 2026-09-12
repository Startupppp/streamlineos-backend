import type { StockMovement } from "../stock-engine/stock-engine.types";

/**
 * B9, item 2 — what each inspection verdict does to the ledger.
 *
 * Extracted from `CustomerReturnsService.post` so the rule has one statement.
 * It used to live inline in the service and again, separately, in
 * `__tests__/returns.spec.ts`, which meant the test asserted a copy: the copy
 * still described QUARANTINE as a single `QUALITY_HOLD` movement months after
 * the service had been corrected to raise ON_HAND as well, and passed.
 */
export type CustomerReturnDisposition =
  | "RESTOCK"
  | "QUARANTINE"
  | "SCRAP"
  | "RETURN_TO_VENDOR";

export type ReturnSerialStatus = "IN_STOCK" | "SCRAPPED" | "QUARANTINE" | "RETURNED";

export interface DispositionLine {
  productVariantId: number;
  disposition: CustomerReturnDisposition | null;
  quantity: string;
  lotId: number | null;
  serialId: number | null;
}

/**
 * The movements one inspected line produces at its resolved location.
 *
 * Returned goods physically arrive, so `ON_HAND` rises like any receipt for
 * every disposition that keeps them; the second movement then makes them
 * unsellable. Raising only the restraining bucket would subtract the arrival
 * from the good stock already on the shelf, and `assertBucketsCoherent` refuses
 * a hold larger than on-hand anyway — which is why the ON_HAND movement is
 * always first in the returned array.
 */
export function movementsForDisposition(
  line: DispositionLine,
  locationId: number,
): StockMovement[] {
  const grain = {
    productVariantId: line.productVariantId,
    locationId,
    lotId: line.lotId ?? undefined,
    serialId: line.serialId ?? undefined,
    quantityDelta: line.quantity,
  };

  switch (line.disposition) {
    case "RESTOCK":
      return [{ ...grain, transactionType: "CUSTOMER_RETURN", qualityBucket: "ON_HAND" }];

    case "QUARANTINE":
      return [
        { ...grain, transactionType: "QUARANTINE_IN", qualityBucket: "ON_HAND" },
        { ...grain, transactionType: "QUARANTINE_IN", qualityBucket: "QUALITY_HOLD" },
      ];

    /*
     * The goods are faulty and it is the supplier's fault. They arrive, they are
     * not sellable, and they are not written off — they wait on the shelf for a
     * vendor RMA to take them away, which is what `BLOCKED` means. Availability
     * already subtracts `blocked_qty`, so nothing downstream has to learn a new
     * rule, and the vendor return that eventually collects them issues the
     * offsetting movement.
     */
    case "RETURN_TO_VENDOR":
      return [
        { ...grain, transactionType: "CUSTOMER_RETURN", qualityBucket: "ON_HAND" },
        { ...grain, transactionType: "CUSTOMER_RETURN", qualityBucket: "BLOCKED" },
      ];

    /*
     * Scrapped goods never enter stock, so there is nothing to remove: the
     * receipt and the write-off would be the same quantity in opposite
     * directions on the same day, and the cost of the goods was already
     * recognised when they shipped. The disposition on the line is the record
     * that they arrived and were condemned.
     */
    case "SCRAP":
      return [];

    // An uninspected line. `post` refuses the whole document before it gets
    // here (INV-209), so this is unreachable rather than lenient.
    case null:
      return [];
  }
}

/**
 * What the unit itself is now.
 *
 * `RETURNED` for RETURN_TO_VENDOR rather than `QUARANTINE`: the serial enum has
 * no "blocked, awaiting RMA" value, and `RETURNED` is true of the unit in both
 * directions of that journey — it came back from the customer, and the vendor
 * return that collects it sets the same status. Conflating it with QUARANTINE
 * would make a condemned unit indistinguishable from one awaiting inspection.
 */
export function serialStatusForDisposition(
  disposition: CustomerReturnDisposition | null,
): ReturnSerialStatus {
  switch (disposition) {
    case "RESTOCK":
      return "IN_STOCK";
    case "SCRAP":
      return "SCRAPPED";
    case "RETURN_TO_VENDOR":
      return "RETURNED";
    case "QUARANTINE":
    case null:
      return "QUARANTINE";
  }
}
