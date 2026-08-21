import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  invStockTransactions,
  invProductVariants,
  invProducts,
} from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { type Db } from "../../../db/drizzle.module";
import { mulDec, isPositive, cmpDec } from "./decimal";
import { ValuationService } from "./valuation.service";
import { costingFor, type CostingLookup } from "./costing-context";
import { type StockEngineResult } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The cost side of a movement, plus the low-stock signal it may raise.
 *
 * Split out of StockEngineService, which was over the 500-line cap and carried
 * byte-identical copies of the low-stock block in both executeInTx and
 * executeMany.
 */
@Injectable()
export class MovementCostingService {
  constructor(private readonly valuation: ValuationService) {}

  /**
   * Applies the movement's cost side: a receipt creates a layer (and, for
   * weighted average, a recorded recomputation); an issue consumes layers at the
   * product's own costing method and returns the resulting COGS, which is then
   * stamped on the stock transaction. Outbound rows previously carried a null
   * cost, so COGS could not be reconstructed at all.
   */
  async applyCosting(
    tx: Tx,
    orgId: string,
    costing: CostingLookup,
    movement: {
      productVariantId: number;
      locationId: number;
      lotId?: number | null;
    },
    txnId: number,
    delta: string,
    unitCost: string | null,
    onHandBefore: string,
    averageCostBefore: string | null,
    allowNegativeStock: boolean,
    sourceType: string | null,
    sourceId: string,
  ): Promise<string | null> {
    const { costingMethod, standardCost } = costingFor(
      costing,
      movement.productVariantId,
    );
    const key = {
      orgId,
      productVariantId: movement.productVariantId,
      locationId: movement.locationId,
      lotId: movement.lotId ?? null,
    };

    if (isPositive(delta)) {
      if (!unitCost) return averageCostBefore;
      return this.valuation.recordReceipt(tx, {
        ...key,
        stockTransactionId: txnId,
        quantity: delta,
        unitCost,
        costingMethod,
        onHandBefore,
        averageCostBefore,
        sourceType,
        sourceId,
      });
    }

    const issued = await this.valuation.recordIssue(tx, {
      ...key,
      stockTransactionId: txnId,
      quantity: mulDec(delta, "-1"),
      costingMethod,
      averageCost: averageCostBefore,
      standardCost,
      allowUncovered: allowNegativeStock,
      sourceType,
      sourceId,
    });

    await tx
      .update(invStockTransactions)
      .set({ unitCost: issued.unitCost, totalCost: issued.totalCost })
      .where(eq(invStockTransactions.id, txnId));

    return averageCostBefore;
  }

  /**
   * Emits inventory.stock.low for variants that fell to or below their reorder
   * point. Extracted because executeInTx and executeMany carried byte-identical
   * copies of this block.
   */
  async emitLowStock(
    tx: Tx,
    orgId: string,
    decreasedVariantIds: ReadonlySet<number>,
    levels: StockEngineResult["levels"],
    sourceType: string,
    sourceId: string,
  ): Promise<void> {
    if (decreasedVariantIds.size === 0) return;

    const variantIds = Array.from(decreasedVariantIds);
    const variants = await tx
      .select({ id: invProductVariants.id, reorderPoint: invProducts.reorderPoint })
      .from(invProductVariants)
      .innerJoin(invProducts, eq(invProducts.id, invProductVariants.productId))
      .where(inArray(invProductVariants.id, variantIds));

    const onHandByVariant = new Map<number, string>();
    for (const level of levels)
      if (decreasedVariantIds.has(level.productVariantId))
        onHandByVariant.set(level.productVariantId, level.onHand);

    for (const variant of variants) {
      if (cmpDec(variant.reorderPoint ?? "0", "0") <= 0) continue;
      const onHand = onHandByVariant.get(variant.id) ?? "0";
      if (cmpDec(onHand, variant.reorderPoint ?? "0") > 0) continue;
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "inv_product_variant",
        aggregateId: String(variant.id),
        aggregateVersion: Date.now(),
        eventType: "inventory.stock.low",
        payload: {
          productVariantId: variant.id,
          onHand,
          reorderPoint: variant.reorderPoint,
          sourceType,
          sourceId,
        },
        occurredAt: new Date(),
      });
    }
  }
}
