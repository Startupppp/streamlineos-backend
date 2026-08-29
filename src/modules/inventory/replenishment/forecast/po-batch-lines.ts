import { BadRequestException } from "@nestjs/common";
import { addDec, mulDec, subDec } from "../../stock-engine/decimal";
import { atLeastZero, isPositiveExact } from "./exact";
import {
  applyOrderPolicy,
  type BatchKeyFields,
  type BatchLine,
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

export interface ProposalResolution {
  lines: Array<BatchLine & BatchKeyFields & { proposalId: number }>;
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
 * Why this proposal cannot become a line, or null when it can.
 *
 * Stated rather than filtered: a proposal that vanishes from a batch with no
 * explanation reads as a bug, and the reason is exactly what tells the buyer
 * whether to fix the supplier record or leave the item alone.
 */
export function blockedReason(row: ResolvedProposalRow, ordered: string): string | null {
  if (!row.applicable || row.reorderPoint === null) {
    return (
      row.refusalReason ??
      "The forecast engine would not commit to a quantity for this item."
    );
  }
  if (row.vendorId === null || row.vendorName === null || row.currency === null)
    return "No supplier is set for this item, so there is nobody to order it from.";
  if (row.duplicatePoNumber !== null)
    return `Already on draft purchase order ${row.duplicatePoNumber}, so ordering it again would double the delivery.`;
  if (!isPositiveExact(ordered))
    return "The position already covers the reorder point.";
  return null;
}

/** Turn resolved proposals into order lines, keeping every refusal. */
export function resolveProposalLines(
  rows: readonly ResolvedProposalRow[],
): ProposalResolution {
  const lines: ProposalResolution["lines"] = [];
  const skipped: SkippedProposal[] = [];

  for (const row of rows) {
    const rounded = orderQuantityFor(row);
    const blocked = blockedReason(row, rounded.ordered);
    if (blocked !== null || row.vendorId === null || row.vendorName === null || row.currency === null) {
      skipped.push({
        proposalId: row.proposalId,
        productVariantId: row.productVariantId,
        reason: blocked ?? "This proposal produces no order line.",
      });
      continue;
    }

    const unitCost = row.lastUnitCost ?? "0.0000";
    lines.push({
      proposalId: row.proposalId,
      productVariantId: row.productVariantId,
      productName: `${row.productName} (${row.variantSku})`,
      requested: rounded.requested,
      ordered: rounded.ordered,
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
