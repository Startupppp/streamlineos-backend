/**
 * INV-309 — turning a proposed quantity into an orderable one.
 *
 * A bare quantity is not an order. Suppliers sell in cases and refuse to ship
 * below a minimum, so a proposal for 7 units against a case of 12 and a minimum
 * of 24 is an order for 24 — and the difference between "we need 7" and "we
 * will buy 24" is a real commercial decision that has to be visible rather than
 * applied silently at the last moment.
 *
 * Rounding is always up. Rounding a shortfall down produces an order that does
 * not fix the shortfall, which is the one outcome with no argument for it.
 *
 * C1 made every figure here exact. These are order quantities and money: they
 * are written to `inv_po_lines.quantity`, `unit_cost` and `amount`, and they are
 * what the supplier invoices against. A pack-size rounding decided by
 * `Math.ceil(ordered / multiple)` in floating point is wrong exactly at the
 * boundary — `Math.ceil(24 / 0.1)` is 241, not 240 — and the boundary is where
 * every one of these decisions sits. So the whole file works in decimal strings
 * and every comparison goes through `cmpDec`.
 */
import { addDec, cmpDec, divDec, mulDec, subDec } from "../../stock-engine/decimal";

export interface OrderPolicy {
  /** Exact decimal string, or null when the supplier sets no minimum. */
  minOrderQty: string | null;
  /** Exact decimal string, or null when the supplier sells in any quantity. */
  orderMultiple: string | null;
}

export interface RoundedOrder {
  requested: string;
  ordered: string;
  /** Units bought beyond what was needed, because of the policy. */
  excess: string;
  reasons: string[];
}

/**
 * How many whole packs cover `quantity`, exactly.
 *
 * `divDec` rounds half-up rather than down, so its result cannot be trusted as
 * a floor. The count is taken from the integer part and then *verified* by
 * multiplying back: if the packs do not cover the quantity, one more is needed.
 * That check is what makes this correct for both directions of the rounding.
 */
function packsFor(quantity: string, multiple: string): string {
  const whole = divDec(quantity, multiple).split(".")[0] ?? "0";
  return cmpDec(mulDec(whole, multiple), quantity) < 0 ? addDec(whole, "1") : whole;
}

export function applyOrderPolicy(
  requested: string,
  policy: OrderPolicy,
): RoundedOrder {
  const reasons: string[] = [];
  let ordered = requested;

  // A shortfall of zero is not a small shortfall; it is no shortfall. The
  // supplier's minimum applies to an order somebody has decided to place, not
  // to the decision of whether to place one — without this, every variant whose
  // position is already healthy was raised to the minimum and bought.
  if (cmpDec(requested, "0") <= 0) {
    return { requested: "0.0000", ordered: "0.0000", excess: "0.0000", reasons: [] };
  }

  if (policy.minOrderQty !== null && cmpDec(ordered, policy.minOrderQty) < 0) {
    reasons.push(
      `Raised to the supplier's minimum order quantity of ${policy.minOrderQty}.`,
    );
    ordered = policy.minOrderQty;
  }

  if (policy.orderMultiple !== null && cmpDec(policy.orderMultiple, "0") > 0) {
    const packs = packsFor(ordered, policy.orderMultiple);
    const rounded = mulDec(packs, policy.orderMultiple);
    if (cmpDec(rounded, ordered) !== 0) {
      reasons.push(
        `Rounded up to ${packs} × ${policy.orderMultiple} to match the supplier's pack size.`,
      );
      ordered = rounded;
    }
  }

  return {
    requested: addDec(requested, "0"),
    ordered: addDec(ordered, "0"),
    excess: subDec(ordered, requested),
    reasons,
  };
}

export interface BatchLine {
  productVariantId: number;
  productName: string;
  requested: string;
  ordered: string;
  unitCost: string;
  lineValue: string;
  excess: string;
  reasons: string[];
}

/** What decides which purchase order a line belongs on. */
export interface BatchKeyFields {
  vendorId: number;
  vendorName: string;
  /** Null means the proposal was made for the organisation rather than a site. */
  warehouseId: number | null;
  warehouseName: string | null;
  currency: string;
}

export interface SupplierSiteBatch extends BatchKeyFields {
  lines: BatchLine[];
  totalValue: string;
  /** Units bought beyond need across the batch, so the cost of the policy is visible. */
  totalExcessUnits: string;
  requiresApproval: boolean;
  approvalReason?: string;
}

/** The grouping key, exposed so a caller can talk about a batch it has not built yet. */
export function batchKey(fields: {
  vendorId: number;
  warehouseId: number | null;
  currency: string;
}): string {
  return `${fields.vendorId}|${fields.warehouseId ?? "org"}|${fields.currency}`;
}

/**
 * C6 — group lines into one order per supplier, site and currency.
 *
 * One order per vendor rather than one per SKU is the point a buyer feels: a
 * supplier receiving eleven separate orders for eleven items on the same day
 * charges eleven delivery fees and the warehouse books eleven receipts.
 *
 * Vendor alone is not the key, though, and the two extra terms are not
 * decoration. **Warehouse** is on the purchase order header and decides where
 * the goods are received, so merging two sites onto one order sends every unit
 * to whichever site happened to sort first. **Currency** is also on the header
 * and there is exactly one of it: putting a USD line and an INR line on one
 * order produces a total in no currency at all, which then flows into the
 * receipt, the valuation and the supplier's invoice reconciliation.
 */
export function batchProposals(
  lines: Array<BatchLine & BatchKeyFields>,
  policy: { requireApproval: boolean; approvalThreshold: string | null },
): SupplierSiteBatch[] {
  const batches = new Map<string, SupplierSiteBatch>();

  for (const line of lines) {
    const key = batchKey(line);
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        vendorId: line.vendorId,
        vendorName: line.vendorName,
        warehouseId: line.warehouseId,
        warehouseName: line.warehouseName,
        currency: line.currency,
        lines: [],
        totalValue: "0.0000",
        totalExcessUnits: "0.0000",
        requiresApproval: false,
      };
      batches.set(key, batch);
    }
    batch.lines.push(line);
    // Money, summed exactly. A batch total is what the approval threshold is
    // checked against and what the vendor is committed to.
    batch.totalValue = addDec(batch.totalValue, line.lineValue);
    batch.totalExcessUnits = addDec(batch.totalExcessUnits, line.excess);
  }

  return [...batches.values()].map((batch) => {
    const totalValue = batch.totalValue;
    // The threshold is checked against the batched total, not the line. An
    // approval policy evaluated per line is trivially avoided by splitting the
    // order, which is exactly what batching just stopped happening by accident.
    const overThreshold =
      policy.approvalThreshold !== null &&
      cmpDec(totalValue, policy.approvalThreshold) > 0;
    return {
      ...batch,
      totalValue,
      requiresApproval: policy.requireApproval || overThreshold,
      approvalReason: policy.requireApproval
        ? "This organisation requires approval for every purchase order."
        : overThreshold
          ? `Order value ${totalValue} exceeds the approval threshold of ${policy.approvalThreshold}.`
          : undefined,
    };
  });
}
