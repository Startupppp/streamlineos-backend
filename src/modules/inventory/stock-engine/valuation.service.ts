import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import {
  invValuationLayers,
  invValuationConsumptions,
  invAverageCostHistory,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { addDec, mulDec, divDec, cmpDec } from "./decimal";
import { INV_ERRORS } from "./stock-engine.types";
import {
  planIssue,
  type CostingMethod,
  type IssueInput,
  type IssuePlan,
  type IssueResult,
  type LayerKey,
  type PlannedIssueInput,
} from "./lib/issue-plan";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The decision half of an issue lives in `lib/issue-plan.ts`; these are its
 * types, re-exported so `movement-costing.service.ts`, `costing-context.ts` and
 * every existing importer keep resolving them from here.
 */
export type {
  CostingMethod,
  IssueInput,
  IssuePlan,
  IssueResult,
  LayerKey,
  PlannedIssueInput,
};

export interface ReceiptInput extends LayerKey {
  stockTransactionId: number;
  quantity: string;
  unitCost: string;
  costingMethod: CostingMethod;
  onHandBefore: string;
  averageCostBefore: string | null;
  sourceType: string | null;
  sourceId: string;
}

/**
 * Owns cost layers, layer consumption and COGS.
 *
 * Two rules the previous implementation broke:
 *  - the costing method on the product is dispatched on, rather than every
 *    product being averaged on receipt and consumed FIFO on issue;
 *  - each issue records WHICH layers it consumed, in what quantity, at what
 *    cost, so COGS is reproducible instead of being an in-place decrement of
 *    remaining_quantity that leaves no trace.
 *
 * Every write in the valuation path is here. The one thing that is not is the
 * costing DECISION, which writes nothing and reads its own file — see
 * `lib/issue-plan.ts` for why that line is where it is.
 */
@Injectable()
export class ValuationService {
  async recordReceipt(tx: Tx, input: ReceiptInput): Promise<string | null> {
    const totalValue = mulDec(input.quantity, input.unitCost);

    await tx.insert(invValuationLayers).values({
      orgId: input.orgId,
      productVariantId: input.productVariantId,
      locationId: input.locationId,
      lotId: input.lotId,
      stockTransactionId: input.stockTransactionId,
      quantity: input.quantity,
      unitCost: input.unitCost,
      totalValue,
      remainingQuantity: input.quantity,
      remainingValue: totalValue,
      costingMethod: input.costingMethod,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });

    if (input.costingMethod !== "WEIGHTED_AVERAGE")
      return input.averageCostBefore;

    const averageAfter = weightedAverage(
      input.onHandBefore,
      input.averageCostBefore,
      input.quantity,
      input.unitCost,
    );

    await tx.insert(invAverageCostHistory).values({
      orgId: input.orgId,
      productVariantId: input.productVariantId,
      stockTransactionId: input.stockTransactionId,
      quantityBefore: input.onHandBefore,
      averageBefore: input.averageCostBefore,
      quantityIn: input.quantity,
      unitCostIn: input.unitCost,
      averageAfter,
    });

    return averageAfter;
  }

  /**
   * Works out what an issue will cost, taking the layer locks it will need.
   * Writes nothing; see `lib/issue-plan.ts`. The locks it takes are held by
   * `tx` until `commitIssue` below runs against them.
   */
  planIssue(tx: Tx, input: PlannedIssueInput): Promise<IssuePlan> {
    return planIssue(tx, input);
  }

  /**
   * Records a planned issue against the fact row it belongs to. Every write the
   * old `recordIssue` performed happens here, in the same order, against layers
   * this transaction already holds locks on.
   */
  async commitIssue(
    tx: Tx,
    input: PlannedIssueInput,
    plan: IssuePlan,
    stockTransactionId: number,
  ): Promise<void> {
    for (const draw of plan.draws) {
      await tx
        .update(invValuationLayers)
        .set({
          remainingQuantity: draw.remainingAfter,
          remainingValue: mulDec(draw.remainingAfter, draw.layerUnitCost),
        })
        .where(eq(invValuationLayers.id, draw.layerId));

      await tx.insert(invValuationConsumptions).values({
        orgId: input.orgId,
        stockTransactionId,
        valuationLayerId: draw.layerId,
        quantity: draw.take,
        unitCost: draw.unitCost,
        totalCost: draw.lineCost,
      });
    }

    if (plan.uncovered) {
      await this.recordUncovered(
        tx,
        { ...input, stockTransactionId },
        plan.uncovered.quantity,
        plan.uncovered.unitCost,
      );
    }
  }

  /**
   * Plan and commit in one call, for callers that already hold the fact row's
   * id. The engine no longer takes this path — it needs the cost before the row
   * exists — but the behaviour is identical and the unit tests exercise it.
   */
  async recordIssue(tx: Tx, input: IssueInput): Promise<IssueResult> {
    const plan = await this.planIssue(tx, input);
    await this.commitIssue(tx, input, plan, input.stockTransactionId);
    return {
      totalCost: plan.totalCost,
      unitCost: plan.unitCost,
      uncoveredQuantity: plan.uncoveredQuantity,
    };
  }

  /**
   * Unwinds a specific layer created by a receipt that is being reversed, rather
   * than consuming unrelated older layers — which is what a plain negative
   * movement would do and would leave the erroneous layer sitting in stock.
   */
  async reverseReceiptLayer(
    tx: Tx,
    orgId: string,
    stockTransactionId: number,
  ): Promise<boolean> {
    const [layer] = await tx.execute<{
      id: number;
      remaining_quantity: string;
      quantity: string;
    }>(sql`
      SELECT id, remaining_quantity, quantity
      FROM inv_valuation_layers
      WHERE org_id = ${orgId} AND stock_transaction_id = ${stockTransactionId}
      FOR UPDATE
    `);
    if (!layer) return false;
    if (cmpDec(layer.remaining_quantity, layer.quantity) !== 0) {
      throw new UnprocessableEntityException({
        code: INV_ERRORS.INVALID_DOCUMENT_STATE,
        message:
          "This receipt has already been partly issued and cannot be reversed directly",
      });
    }
    await tx
      .update(invValuationLayers)
      .set({ remainingQuantity: "0", remainingValue: "0" })
      .where(eq(invValuationLayers.id, layer.id));
    return true;
  }

  /**
   * Stock left without a cost basis — only reachable when the org permits
   * negative stock. Recorded as a fully-consumed layer so the consumption keeps
   * its foreign key and the event stays visible rather than vanishing.
   */
  private async recordUncovered(
    tx: Tx,
    input: IssueInput,
    quantity: string,
    unitCost: string,
  ): Promise<void> {
    const totalValue = mulDec(quantity, unitCost);
    const [layer] = await tx
      .insert(invValuationLayers)
      .values({
        orgId: input.orgId,
        productVariantId: input.productVariantId,
        locationId: input.locationId,
        lotId: input.lotId,
        stockTransactionId: input.stockTransactionId,
        quantity,
        unitCost,
        totalValue,
        remainingQuantity: "0",
        remainingValue: "0",
        costingMethod: input.costingMethod,
        sourceType: "negative_stock_backfill",
        sourceId: input.sourceId,
      })
      .returning({ id: invValuationLayers.id });

    if (!layer) return;

    await tx.insert(invValuationConsumptions).values({
      orgId: input.orgId,
      stockTransactionId: input.stockTransactionId,
      valuationLayerId: layer.id,
      quantity,
      unitCost,
      totalCost: totalValue,
    });
  }
}

export function weightedAverage(
  quantityBefore: string,
  averageBefore: string | null,
  quantityIn: string,
  unitCostIn: string,
): string {
  const total = addDec(quantityBefore, quantityIn);
  if (cmpDec(total, "0") <= 0) return unitCostIn;
  const valueBefore = mulDec(quantityBefore, averageBefore ?? "0");
  const valueIn = mulDec(quantityIn, unitCostIn);
  return divDec(addDec(valueBefore, valueIn), total);
}
