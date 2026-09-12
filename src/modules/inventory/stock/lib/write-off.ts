import { BadRequestException } from "@nestjs/common";
import { isPositive } from "../../stock-engine/decimal";

/**
 * D8 — what makes an adjustment a write-off, stated once.
 *
 * A write-off is not a second kind of document. It is a stock adjustment whose
 * reason condemns the goods, and the adjustment already owns everything a
 * write-off needs: a value threshold, an approval status, maker-checker on
 * approval, an idempotency claim spanning the whole command, and an append-only
 * ledger. A parallel `inv_write_offs` table with its own ladder would have
 * duplicated all five and left two routes for stock to leave the building.
 *
 * The contrast worth keeping in view is B9. A returned line dispositioned
 * `SCRAP` posts **no** movement, because those goods never entered stock — the
 * receipt and the write-off would be the same quantity in opposite directions
 * on the same day. Here the goods *are* on the shelf: they are counted, they
 * are valued, and destroying them has to remove both. So a write-off always
 * posts a movement, and that movement is an issue, which is what gives it a
 * real COGS from the layers it consumes rather than a null.
 */
export const WRITE_OFF_REASONS = ["DAMAGE", "EXPIRY", "THEFT", "SCRAP"] as const;

export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

const WRITE_OFF_REASON_SET: ReadonlySet<string> = new Set(WRITE_OFF_REASONS);

export function isWriteOffReason(reason: string): boolean {
  return WRITE_OFF_REASON_SET.has(reason);
}

/**
 * The ledger type one adjustment line posts as.
 *
 * `SCRAP` rather than `ADJUSTMENT_OUT` for a condemned line, so the movement
 * history says what happened to the goods rather than only that the number
 * changed. Both are issues and both consume cost layers identically; the
 * difference is legibility, and it is the difference between a stock report
 * that can separate shrinkage from a recount and one that cannot.
 */
export function adjustmentMovementType(
  reason: string,
  quantityChange: string,
): "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" | "SCRAP" {
  if (isPositive(quantityChange)) return "ADJUSTMENT_IN";
  return isWriteOffReason(reason) ? "SCRAP" : "ADJUSTMENT_OUT";
}

/**
 * A write-off may only remove stock.
 *
 * Without this, `{ reason: "THEFT", quantityChange: +40 }` was accepted and
 * posted as an `ADJUSTMENT_IN` — stock conjured onto the shelf under a reason
 * that says it was stolen, which is both a nonsense document and the most
 * convenient shape available to somebody covering a theft up.
 */
export function assertWriteOffRemovesStock(
  reason: string,
  lines: ReadonlyArray<{ quantityChange: number }>,
): void {
  const raised = lines.filter((line) => line.quantityChange > 0).length;
  if (raised === 0) return;
  throw new BadRequestException(
    `A ${reason} write-off may only remove stock, and ${String(raised)} of its lines add stock. Raise a separate adjustment for the increase.`,
  );
}

/**
 * The write-off value, hidden from a caller who may not see cost.
 *
 * `stripCostFields` keys on a fixed list of field names owned by the engine,
 * and `writtenOffValue` is not on it, so the omission is explicit here rather
 * than silently absent. Supplier cost is commercially sensitive and frequently
 * NDA-bound; a warehouse operator holding `inventory:stock:read` and not
 * `inventory:valuation:read` must not receive it in the payload at all.
 */
export function withoutWriteOffValue<T extends object>(row: T): T {
  if (!("writtenOffValue" in row)) return row;
  const copy: Record<string, unknown> = { ...row };
  delete copy.writtenOffValue;
  return copy as T;
}
