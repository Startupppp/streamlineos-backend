import { UnprocessableEntityException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { addDec, subDec, mulDec, divDec, cmpDec } from "../decimal";
import { INV_ERRORS } from "../stock-engine.types";
import { assertNever } from "../../../../common/types/assert-never";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The decision half of costing an issue — the seam `ValuationService`'s own doc
 * already named, made into a file.
 *
 * That doc (on `IssuePlan`, below) explains why the issue was split in two: the
 * old `recordIssue` costed the movement *after* inserting the stock transaction
 * and then UPDATEd that row with the answer, so a posted movement had to stay
 * editable and the ledger could not be made append-only. `planIssue` decides;
 * the caller inserts the fact row already carrying the cost; `commitIssue`
 * records the consumption against it. The file boundary is that same line, and
 * it is a real one rather than a size convenience:
 *
 *  - NOTHING here writes. `planIssue` and its three helpers issue exactly one
 *    statement, a `SELECT … FOR UPDATE`, and return a value. Every INSERT and
 *    UPDATE in the valuation path is on the other side of this file.
 *  - The locks the SELECT takes are held by the caller's transaction until
 *    `commitIssue` runs, which is what makes "decide now, write later" safe;
 *    that contract is stated once here and depended on there.
 *
 * The service keeps the writes (`recordReceipt`, `commitIssue`,
 * `recordUncovered`, `reverseReceiptLayer`) and re-exports the types below, so
 * existing imports from `./valuation.service` are unchanged. Nothing in this
 * file imports the service back.
 */
export type CostingMethod = "STANDARD" | "WEIGHTED_AVERAGE" | "FIFO";

/** The grain a cost layer is held at. Shared by the receipt and issue inputs. */
export interface LayerKey {
  orgId: string;
  productVariantId: number;
  locationId: number;
  lotId: number | null;
}

export interface IssueInput extends LayerKey {
  stockTransactionId: number;
  /** Positive magnitude of the quantity leaving stock. */
  quantity: string;
  costingMethod: CostingMethod;
  averageCost: string | null;
  standardCost: string | null;
  allowUncovered: boolean;
  sourceType: string | null;
  sourceId: string;
}

export interface IssueResult {
  /** Total cost of goods issued, from the layers actually consumed. */
  totalCost: string;
  unitCost: string;
  uncoveredQuantity: string;
}

/** One layer an issue will draw from, and what it will cost to draw from it. */
export interface PlannedDraw {
  layerId: number;
  layerUnitCost: string;
  take: string;
  unitCost: string;
  lineCost: string;
  remainingAfter: string;
}

/**
 * A2 — the decision an issue makes, separated from the writes that record it.
 *
 * Costing used to run *after* the stock transaction was inserted, then UPDATE
 * that row with the cost it had worked out. So a posted movement was editable
 * by design, and the ledger could not be made append-only while that was true.
 *
 * Splitting the issue in two removes the need: `planIssue` locks the layers and
 * works out the cost, the caller inserts the fact row already carrying it, and
 * `commitIssue` writes the layer consumption against the row's id. The layer
 * locks are taken in `planIssue` and held by the surrounding transaction until
 * commit, so nothing can consume them in between.
 */
export interface IssuePlan extends IssueResult {
  draws: PlannedDraw[];
  /** Quantity no layer covered, and the cost it will be backfilled at. */
  uncovered: { quantity: string; unitCost: string } | null;
}

/** An issue's inputs, before the fact row it will be recorded against exists. */
export type PlannedIssueInput = Omit<IssueInput, "stockTransactionId">;

/**
 * Works out what an issue will cost, taking the layer locks it will need.
 * Writes nothing: the caller has not inserted the fact row yet.
 */
export async function planIssue(tx: Tx, input: PlannedIssueInput): Promise<IssuePlan> {
  const empty: IssuePlan = {
    totalCost: "0.0000",
    unitCost: "0.0000",
    uncoveredQuantity: "0.0000",
    draws: [],
    uncovered: null,
  };
  if (cmpDec(input.quantity, "0") <= 0) return empty;

  const layers = await lockConsumableLayers(tx, input);

  const draws: PlannedDraw[] = [];
  let outstanding = input.quantity;
  let totalCost = "0.0000";

  for (const layer of layers) {
    if (cmpDec(outstanding, "0") <= 0) break;
    const available = layer.remaining_quantity;
    const take = cmpDec(available, outstanding) < 0 ? available : outstanding;

    const unitCost = issueUnitCost(input, layer.unit_cost);
    const lineCost = mulDec(take, unitCost);

    draws.push({
      layerId: layer.id,
      layerUnitCost: layer.unit_cost,
      take,
      unitCost,
      lineCost,
      remainingAfter: subDec(available, take),
    });

    outstanding = subDec(outstanding, take);
    totalCost = addDec(totalCost, lineCost);
  }

  let uncovered: IssuePlan["uncovered"] = null;
  if (cmpDec(outstanding, "0") > 0) {
    // The layers do not cover the issue. With negative stock blocked this can
    // only mean the layer ledger has drifted from the snapshot, which must be
    // loud rather than silently under-valuing the issue.
    if (!input.allowUncovered) {
      throw new UnprocessableEntityException({
        code: INV_ERRORS.INSUFFICIENT_STOCK,
        message:
          "Cost layers do not cover this issue — valuation has drifted from stock on hand",
      });
    }
    const fallback = fallbackUnitCost(input);
    uncovered = { quantity: outstanding, unitCost: fallback };
    totalCost = addDec(totalCost, mulDec(outstanding, fallback));
  }

  return {
    totalCost,
    unitCost: divDec(totalCost, input.quantity),
    uncoveredQuantity: outstanding,
    draws,
    uncovered,
  };
}

async function lockConsumableLayers(tx: Tx, input: PlannedIssueInput) {
  // Bounded: a variant with a long tail of open layers previously locked every
  // one of them on every issue. 500 layers is far more than any single issue
  // needs, and a shortfall past that surfaces as an uncovered quantity.
  const lotFilter =
    input.lotId === null
      ? sql`TRUE`
      : sql`lot_id IS NOT DISTINCT FROM ${input.lotId}`;

  return tx.execute<{
    id: number;
    remaining_quantity: string;
    unit_cost: string;
  }>(sql`
    SELECT id, remaining_quantity, unit_cost
    FROM inv_valuation_layers
    WHERE org_id = ${input.orgId}
      AND product_variant_id = ${input.productVariantId}
      AND location_id IS NOT DISTINCT FROM ${input.locationId}
      AND ${lotFilter}
      AND remaining_quantity > 0
    ORDER BY created_at ASC, id ASC
    LIMIT 500
    FOR UPDATE
  `);
}

function issueUnitCost(input: PlannedIssueInput, layerUnitCost: string): string {
  switch (input.costingMethod) {
    case "FIFO":
      return layerUnitCost;
    case "WEIGHTED_AVERAGE":
      return input.averageCost ?? layerUnitCost;
    case "STANDARD":
      return input.standardCost ?? layerUnitCost;
    default: {
      return assertNever(input.costingMethod);
    }
  }
}

/** What uncovered quantity is charged at when the org permits negative stock. */
function fallbackUnitCost(input: PlannedIssueInput): string {
  if (input.costingMethod === "STANDARD" && input.standardCost)
    return input.standardCost;
  return input.averageCost ?? "0.0000";
}
