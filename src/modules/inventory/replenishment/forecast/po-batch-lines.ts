import { BadRequestException } from "@nestjs/common";
import { addDec, mulDec, subDec } from "../../stock-engine/decimal";
import { atLeastZero, isPositiveExact } from "./exact";
import {
  applyOrderPolicy,
  type BatchKeyFields,
  type BatchLine,
  type BatchLineOverride,
  type RoundedOrder,
  type SupplierSiteBatch,
} from "./order-policy";

/**
 * C6 — one persisted proposal, joined to everything an order line needs.
 *
 * Kept as a plain shape with no database in it so the rules below are testable
 * without a Postgres fixture. Every quantity and money field is an exact decimal
 * string; `parseFloat` on any of them is banned (`exact.ts`).
 */
export interface ResolvedProposalRow {
  proposalId: number;
  productVariantId: number;
  warehouseId: number | null;
  warehouseName: string | null;
  /** From the stored forecast version. Null when the model refused. */
  reorderPoint: string | null;
  applicable: boolean;
  refusalReason: string | null;
  generatedAt: string;
  variantSku: string;
  productName: string;
  minOrderQty: string | null;
  orderMultiple: string | null;
  vendorId: number | null;
  vendorName: string | null;
  currency: string | null;
  available: string;
  onOrder: string;
  lastUnitCost: string | null;
  /** The open draft order that already carries this variant, if there is one. */
  duplicatePoNumber: string | null;
}

export interface SkippedProposal {
  proposalId: number;
  productVariantId: number;
  reason: string;
}

/** One person's instruction to order something other than the engine's number. */
export interface ProposalOverride {
  proposalId: number;
  /** Exact decimal string, as stated. Never a float (`exact.ts`). */
  quantity: string;
  reason: string;
}

export type ResolvedBatchLine = BatchLine & BatchKeyFields & { proposalId: number };

export interface ProposalResolution {
  lines: ResolvedBatchLine[];
  skipped: SkippedProposal[];
}

/**
 * How much to order, today, against the reorder point this version committed to.
 *
 * On-order counts. A proposal that ignores goods already in transit is how a
 * warehouse buys the same shortfall three weeks running — the same reasoning
 * `ReorderProposalService` gives, and the same arithmetic, so the two surfaces
 * cannot disagree about a number a buyer signs.
 */
export function orderQuantityFor(row: ResolvedProposalRow): RoundedOrder {
  const shortfall = atLeastZero(
    subDec(row.reorderPoint ?? "0", addDec(row.available, row.onOrder)),
  );
  return applyOrderPolicy(shortfall, {
    minOrderQty: row.minOrderQty,
    orderMultiple: row.orderMultiple,
  });
}

/**
 * C2 — an override goes through the supplier's policy too.
 *
 * A person overruling the engine is overruling *the quantity*, not the case
 * size. A buyer who asks for 30 against a case of 12 gets 36, exactly as the
 * engine would, because the vendor rejects an off-pack order whoever chose the
 * number. The reason is attached to the line so the rounding stays attributable
 * to the policy and the quantity to the person.
 */
export function overrideQuantityFor(
  row: ResolvedProposalRow,
  override: ProposalOverride,
  engineOrdered: string,
): RoundedOrder {
  const rounded = applyOrderPolicy(override.quantity, {
    minOrderQty: row.minOrderQty,
    orderMultiple: row.orderMultiple,
  });
  return {
    ...rounded,
    reasons: [
      `Overridden by a person from the engine's ${engineOrdered} to ${override.quantity}: ${override.reason}`,
      ...rounded.reasons,
    ],
  };
}

/**
 * Why this proposal cannot become a line, or null when it can.
 *
 * Stated rather than filtered: a proposal that vanishes from a batch with no
 * explanation reads as a bug, and the reason is exactly what tells the buyer
 * whether to fix the supplier record or leave the item alone.
 */
export function blockedReason(
  row: ResolvedProposalRow,
  ordered: string,
  override?: ProposalOverride,
): string | null {
  // These two are physical, not statistical, and no amount of human conviction
  // resolves either: an order with no supplier has nowhere to go, and a second
  // order for a variant already on an unsent draft doubles the delivery.
  if (row.vendorId === null || row.vendorName === null || row.currency === null)
    return "No supplier is set for this item, so there is nobody to order it from.";
  if (row.duplicatePoNumber !== null)
    return `Already on draft purchase order ${row.duplicatePoNumber}, so ordering it again would double the delivery.`;

  // An override answers exactly the two below. "The engine would not commit to a
  // quantity" and "the position already covers the reorder point" are the
  // engine's judgement, and a stated, recorded human judgement is allowed to
  // disagree with it — that is what an override is for, and refusing it here is
  // what pushes a buyer into raising the order by hand where nothing records
  // why.
  if (override !== undefined) return null;

  if (!row.applicable || row.reorderPoint === null) {
    return (
      row.refusalReason ??
      "The forecast engine would not commit to a quantity for this item."
    );
  }
  if (!isPositiveExact(ordered))
    return "The position already covers the reorder point.";
  return null;
}

/**
 * Turn resolved proposals into order lines, keeping every refusal.
 *
 * An override replaces the *quantity* and nothing else: the same supplier, the
 * same site, the same policy rounding, the same duplicate check. It is carried
 * onto the line rather than substituted into it, so the engine's own number
 * survives all the way to the buyer's screen and to `inv_proposal_overrides`.
 */
export function resolveProposalLines(
  rows: readonly ResolvedProposalRow[],
  overrides: readonly ProposalOverride[] = [],
): ProposalResolution {
  const lines: ResolvedBatchLine[] = [];
  const skipped: SkippedProposal[] = [];
  const overrideByProposal = new Map(overrides.map((o) => [o.proposalId, o]));

  for (const row of rows) {
    const override = overrideByProposal.get(row.proposalId);
    const engine = orderQuantityFor(row);
    const rounded =
      override === undefined ? engine : overrideQuantityFor(row, override, engine.ordered);
    const blocked = blockedReason(row, rounded.ordered, override);
    if (blocked !== null || row.vendorId === null || row.vendorName === null || row.currency === null) {
      skipped.push({
        proposalId: row.proposalId,
        productVariantId: row.productVariantId,
        reason: blocked ?? "This proposal produces no order line.",
      });
      continue;
    }

    const unitCost = row.lastUnitCost ?? "0.0000";
    const lineOverride: BatchLineOverride | null =
      override === undefined
        ? null
        : { requested: override.quantity, reason: override.reason };

    lines.push({
      proposalId: row.proposalId,
      productVariantId: row.productVariantId,
      productName: `${row.productName} (${row.variantSku})`,
      requested: rounded.requested,
      ordered: rounded.ordered,
      engineOrdered: engine.ordered,
      override: lineOverride,
      unitCost,
      lineValue: mulDec(rounded.ordered, unitCost),
      excess: rounded.excess,
      reasons: rounded.reasons,
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      warehouseId: row.warehouseId,
      warehouseName: row.warehouseName,
      currency: row.currency,
    });
  }

  return { lines, skipped };
}

/**
 * Refuse a set that is not one order.
 *
 * Named separately because it is the rule with the sharpest failure mode: a
 * batch that silently picked the first group would send half the goods to the
 * wrong site or invoice half of them in the wrong currency, and the buyer would
 * find out at the receipt.
 */
export function assertSingleSupplierSite(
  batches: readonly SupplierSiteBatch[],
  vendorId: number,
): void {
  const suppliers = [...new Set(batches.map((b) => b.vendorName))];
  if (suppliers.length > 1) {
    throw new BadRequestException(
      `These proposals span more than one supplier (${suppliers.join(", ")}). A purchase order goes to exactly one, so batch them separately.`,
    );
  }
  const sites = [...new Set(batches.map((b) => b.warehouseName ?? "the organisation"))];
  if (sites.length > 1) {
    throw new BadRequestException(
      `These proposals span more than one warehouse (${sites.join(", ")}). A purchase order is delivered to exactly one, so batch them separately.`,
    );
  }
  const currencies = [...new Set(batches.map((b) => b.currency))];
  if (currencies.length > 1) {
    throw new BadRequestException(
      `These proposals span more than one currency (${currencies.join(", ")}). A purchase order is priced in exactly one, so batch them separately.`,
    );
  }
  const batch = batches[0];
  if (batch && batch.vendorId !== vendorId) {
    throw new BadRequestException(
      `These proposals belong to ${batch.vendorName}, not to the supplier named in the request.`,
    );
  }
}
