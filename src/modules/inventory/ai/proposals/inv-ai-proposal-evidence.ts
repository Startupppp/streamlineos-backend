import { createHash } from "node:crypto";
import type { BatchableProposal } from "../../replenishment/forecast/po-batch.service";

/**
 * F4 — the fingerprint of the picture a proposal was reviewed against.
 *
 * A proposal is a claim about a moment. Between the server saying "order 36 of
 * SKU-7 from Acme into Pune" and a human pressing confirm, a receipt can land,
 * a transfer can arrive, another buyer can raise the same draft order, or the
 * supplier on the reorder rule can change. The stored proposal would still read
 * exactly the same, and confirming it would post a number nobody reviewed
 * against a world that no longer exists.
 *
 * So the material figures are hashed at propose time and **recomputed from the
 * live ledger at confirm time**. The comparison is the whole mechanism: it does
 * not ask whether the row changed, it asks whether the *answer* changed, which
 * is the only version of the question a buyer cares about.
 *
 * The fields are listed once, in `MATERIAL_FIELDS`, and both the hash and the
 * spec read them from there. Two lists is how a field gets added to the
 * evidence, forgotten in the hash, and silently stops being checked.
 */

/**
 * What the server computed, and the only thing a confirm is measured against.
 *
 * Every quantity is an exact decimal **string** — these are 18,4 ledger
 * figures, and `parseFloat` on one is how `0.1 + 0.2` ends up on a purchase
 * order. Nothing here originates with the model or with the client.
 */
export interface InvAiProposalEvidence {
  /** The persisted C2 proposal — an `inv_demand_forecasts` version id. */
  proposalId: number;
  productVariantId: number;
  variantSku: string;
  productName: string;
  /** Null means the proposal is about the organisation rather than one site. */
  warehouseId: number | null;
  warehouseName: string | null;
  vendorId: number | null;
  vendorName: string | null;
  currency: string | null;
  /** When the forecast version behind this proposal was generated. */
  generatedAt: string;
  /** The reorder point that version committed to. */
  reorderPoint: string | null;
  /**
   * What the server would order today, through the supplier's minimum and pack
   * size. Recomputed by `PoBatchService`; never supplied by a client, and never
   * read back out of the model's narration.
   */
  suggestedQuantity: string;
  unitCost: string;
  /** Set when an unsent draft order already carries this variant. */
  duplicateOfPoNumber: string | null;
  /** Why this proposal cannot become an order line, or null when it can. */
  blockedReason: string | null;
}

/**
 * The figures a confirm is checked against, in a fixed order.
 *
 * Only what would change the decision. A cosmetic field — a renamed product, a
 * re-worded warehouse — would make every proposal look stale the moment
 * somebody tidied a record, and an alarm that cries wolf gets clicked through
 * until the one that matters is clicked through too.
 *
 * `duplicateOfPoNumber` and `blockedReason` are material and not decoration:
 * "another buyer already raised this" and "the shortfall has since been met"
 * are exactly the two ways a still-valid-looking proposal becomes a double
 * order.
 */
export const MATERIAL_FIELDS = [
  "proposalId",
  "productVariantId",
  "warehouseId",
  "vendorId",
  "suggestedQuantity",
  "unitCost",
  "currency",
  "reorderPoint",
  "duplicateOfPoNumber",
  "blockedReason",
] as const satisfies ReadonlyArray<keyof InvAiProposalEvidence>;

/**
 * A stable fingerprint over the material figures.
 *
 * Field-separated rather than concatenated: without the separator a vendor id
 * of `1` beside a quantity of `23` hashes identically to a vendor id of `12`
 * beside a quantity of `3`, and two different worlds would agree they had not
 * moved.
 */
export function hashProposalEvidence(evidence: InvAiProposalEvidence): string {
  // Inlined rather than assigned to a local, and left that way on purpose. The
  // F6 eval proves nothing on the AI path writes a table by scanning the source
  // for a write call taking a bare identifier; passing the digest input as a
  // named variable makes this hash read like a write to a table of that name.
  // Lifting the expression back out to a variable turns a security assertion
  // into a false positive, so it stays where it is.
  return createHash("sha256")
    .update(
      MATERIAL_FIELDS.map((field) => `${field}=${String(evidence[field] ?? "")}`).join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * The evidence a persisted C2 proposal yields.
 *
 * A straight projection with no arithmetic in it. Every figure was computed by
 * `PoBatchService` — the same resolution the buyer's own batching screen runs —
 * so the AI surface cannot disagree with the procurement surface about what
 * would be ordered.
 */
export function evidenceFromProposal(
  proposal: BatchableProposal,
): InvAiProposalEvidence {
  return {
    proposalId: proposal.proposalId,
    productVariantId: proposal.productVariantId,
    variantSku: proposal.variantSku,
    productName: proposal.productName,
    warehouseId: proposal.warehouseId,
    warehouseName: proposal.warehouseName,
    vendorId: proposal.vendorId,
    vendorName: proposal.vendorName,
    currency: proposal.currency,
    generatedAt: proposal.generatedAt,
    reorderPoint: proposal.reorderPoint,
    suggestedQuantity: proposal.suggestedQuantity,
    unitCost: proposal.unitCost,
    duplicateOfPoNumber: proposal.duplicateOfPoNumber,
    blockedReason: proposal.blockedReason,
  };
}

/**
 * The C1 half — what the forecast behind the proposal was, and how sure it was.
 *
 * Carried beside the order figures rather than folded into the hash. A
 * forecast version is immutable and identified by `proposalId`, which is
 * already hashed; re-hashing its contents would add nothing and would couple
 * staleness to fields the decision does not turn on.
 */
export interface InvAiProposalForecast {
  method: string | null;
  demandCategory: string;
  applicable: boolean;
  refusalReason: string | null;
  serviceLevel: string;
  safetyStock: string | null;
  /** The uncertainty the forecast admitted to, not a point estimate alone. */
  demandMean: string;
  demandStdDev: string;
  leadTimeWeeks: string;
  leadTimeStdDevWeeks: string;
  /** Backtest accuracy of the champion, or null when none was justified. */
  mase: string | null;
  stockoutCensored: boolean;
}
