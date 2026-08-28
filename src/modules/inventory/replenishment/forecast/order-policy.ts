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
 */

export interface OrderPolicy {
  minOrderQty: number | null;
  orderMultiple: number | null;
}

export interface RoundedOrder {
  requested: number;
  ordered: number;
  /** Units bought beyond what was needed, because of the policy. */
  excess: number;
  reasons: string[];
}

export function applyOrderPolicy(
  requested: number,
  policy: OrderPolicy,
): RoundedOrder {
  const reasons: string[] = [];
  let ordered = requested;

  if (policy.minOrderQty !== null && ordered < policy.minOrderQty) {
    reasons.push(
      `Raised to the supplier's minimum order quantity of ${policy.minOrderQty}.`,
    );
    ordered = policy.minOrderQty;
  }

  if (policy.orderMultiple !== null && policy.orderMultiple > 0) {
    const multiples = Math.ceil(ordered / policy.orderMultiple);
    const rounded = multiples * policy.orderMultiple;
    if (rounded !== ordered) {
      reasons.push(
        `Rounded up to ${multiples} × ${policy.orderMultiple} to match the supplier's pack size.`,
      );
      ordered = rounded;
    }
  }

  return {
    requested: Number(requested.toFixed(4)),
    ordered: Number(ordered.toFixed(4)),
    excess: Number((ordered - requested).toFixed(4)),
    reasons,
  };
}

export interface BatchLine {
  productVariantId: number;
  productName: string;
  requested: number;
  ordered: number;
  unitCost: number;
  lineValue: number;
  excess: number;
  reasons: string[];
}

export interface VendorBatch {
  vendorId: number;
  vendorName: string;
  lines: BatchLine[];
  totalValue: number;
  /** Units bought beyond need across the batch, so the cost of the policy is visible. */
  totalExcessUnits: number;
  requiresApproval: boolean;
  approvalReason?: string;
}

/**
 * Group lines into one order per vendor, and decide whether a human signs it.
 *
 * One order per vendor rather than one per SKU is the entire point: a supplier
 * receiving eleven separate orders for eleven items on the same day will charge
 * eleven delivery fees, and the warehouse will book eleven receipts.
 */
export function batchByVendor(
  lines: Array<BatchLine & { vendorId: number; vendorName: string }>,
  policy: { requireApproval: boolean; approvalThreshold: number | null },
): VendorBatch[] {
  const byVendor = new Map<number, VendorBatch>();

  for (const line of lines) {
    let batch = byVendor.get(line.vendorId);
    if (!batch) {
      batch = {
        vendorId: line.vendorId,
        vendorName: line.vendorName,
        lines: [],
        totalValue: 0,
        totalExcessUnits: 0,
        requiresApproval: false,
      };
      byVendor.set(line.vendorId, batch);
    }
    batch.lines.push(line);
    batch.totalValue += line.lineValue;
    batch.totalExcessUnits += line.excess;
  }

  return [...byVendor.values()].map((batch) => {
    const totalValue = Number(batch.totalValue.toFixed(4));
    // The threshold is checked against the batched total, not the line. An
    // approval policy evaluated per line is trivially avoided by splitting the
    // order, which is exactly what batching just stopped happening by accident.
    const overThreshold =
      policy.approvalThreshold !== null && totalValue > policy.approvalThreshold;
    return {
      ...batch,
      totalValue,
      totalExcessUnits: Number(batch.totalExcessUnits.toFixed(4)),
      requiresApproval: policy.requireApproval || overThreshold,
      approvalReason: policy.requireApproval
        ? "This organisation requires approval for every purchase order."
        : overThreshold
          ? `Order value ${totalValue} exceeds the approval threshold of ${policy.approvalThreshold}.`
          : undefined,
    };
  });
}
