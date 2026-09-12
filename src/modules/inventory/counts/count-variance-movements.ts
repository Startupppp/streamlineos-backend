import { cmpDec, isPositive } from "../stock-engine/decimal";
import type { StockMovement } from "../stock-engine/stock-engine.types";

export interface CountVarianceLine {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  varianceQty: string | null;
}

/**
 * The stock movements a posted count owes, for both the cycle count and the
 * wall-to-wall audit — the same rule, written once.
 *
 * Two things it is deliberately careful about.
 *
 * **Grain.** A count line records the lot its `systemQty` was read from, so the
 * correction must name that lot. Posting the variance at (variant, location)
 * alone moves a different `inv_stock_levels` row than the one that was counted:
 * the lot keeps the wrong number for good and a lot-less phantom row absorbs a
 * correction nobody counted.
 *
 * **Exactness.** `variance_qty` is `numeric(18,4)` and arrives as a string. It
 * is passed through untouched rather than through `parseFloat` and `toFixed(4)`,
 * which is the float round-trip the ledger rules forbid on a quantity.
 */
export function buildCountVarianceMovements(lines: readonly CountVarianceLine[]): StockMovement[] {
  return lines
    .filter((line): line is CountVarianceLine & { varianceQty: string } =>
      line.varianceQty !== null && cmpDec(line.varianceQty, "0") !== 0)
    .map((line) => ({
      transactionType: isPositive(line.varianceQty) ? "CYCLE_COUNT_GAIN" : "CYCLE_COUNT_LOSS",
      productVariantId: line.productVariantId,
      locationId: line.locationId,
      lotId: line.lotId ?? undefined,
      quantityDelta: line.varianceQty,
    }));
}
