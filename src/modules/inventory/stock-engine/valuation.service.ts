import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import {
  invValuationLayers,
  invValuationConsumptions,
  invAverageCostHistory,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { addDec, subDec, mulDec, divDec, cmpDec } from "./decimal";
import { INV_ERRORS } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CostingMethod = "STANDARD" | "WEIGHTED_AVERAGE" | "FIFO";

export interface LayerKey {
  orgId: string;
  productVariantId: number;
  locationId: number;
  lotId: number | null;
}

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

/**
 * Owns cost layers, layer consumption and COGS.
 *
 * Two rules the previous implementation broke:
 *  - the costing method on the product is dispatched on, rather than every
 *    product being averaged on receipt and consumed FIFO on issue;
 *  - each issue records WHICH layers it consumed, in what quantity, at what
 *    cost, so COGS is reproducible instead of being an in-place decrement of
 *    remaining_quantity that leaves no trace.
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

  async recordIssue(tx: Tx, input: IssueInput): Promise<IssueResult> {
    if (cmpDec(input.quantity, "0") <= 0) {
      return {
        totalCost: "0.0000",
        unitCost: "0.0000",
        uncoveredQuantity: "0.0000",
      };
    }

    const layers = await this.lockConsumableLayers(tx, input);

    let outstanding = input.quantity;
    let totalCost = "0.0000";

    for (const layer of layers) {
      if (cmpDec(outstanding, "0") <= 0) break;
      const available = layer.remaining_quantity;
      const take = cmpDec(available, outstanding) < 0 ? available : outstanding;

      const unitCost = this.issueUnitCost(input, layer.unit_cost);
      const lineCost = mulDec(take, unitCost);

      const newRemaining = subDec(available, take);
      await tx
        .update(invValuationLayers)
        .set({
          remainingQuantity: newRemaining,
          remainingValue: mulDec(newRemaining, layer.unit_cost),
        })
        .where(eq(invValuationLayers.id, layer.id));

      await tx.insert(invValuationConsumptions).values({
        orgId: input.orgId,
        stockTransactionId: input.stockTransactionId,
        valuationLayerId: layer.id,
        quantity: take,
        unitCost,
        totalCost: lineCost,
      });

      outstanding = subDec(outstanding, take);
      totalCost = addDec(totalCost, lineCost);
    }

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
      const fallback = this.fallbackUnitCost(input);
      const backfillCost = mulDec(outstanding, fallback);
      await this.recordUncovered(tx, input, outstanding, fallback);
      totalCost = addDec(totalCost, backfillCost);
    }

    const uncovered = outstanding;
    return {
      totalCost,
      unitCost: divDec(totalCost, input.quantity),
      uncoveredQuantity: uncovered,
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

  private async lockConsumableLayers(tx: Tx, input: IssueInput) {
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

  private issueUnitCost(input: IssueInput, layerUnitCost: string): string {
    switch (input.costingMethod) {
      case "FIFO":
        return layerUnitCost;
      case "WEIGHTED_AVERAGE":
        return input.averageCost ?? layerUnitCost;
      case "STANDARD":
        return input.standardCost ?? layerUnitCost;
      default: {
        const exhaustive: never = input.costingMethod;
        return exhaustive;
      }
    }
  }

  private fallbackUnitCost(input: IssueInput): string {
    if (input.costingMethod === "STANDARD" && input.standardCost)
      return input.standardCost;
    return input.averageCost ?? "0.0000";
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
