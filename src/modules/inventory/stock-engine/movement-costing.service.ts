import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { invProductVariants, invProducts } from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { type Db } from "../../../db/drizzle.module";
import { mulDec, isPositive, cmpDec } from "./decimal";
import {
  ValuationService,
  type CostingMethod,
  type IssuePlan,
  type PlannedIssueInput,
} from "./valuation.service";
import { costingFor, type CostingLookup } from "./costing-context";
import { type StockEngineResult } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Everything the cost side of one movement needs, before it is posted. */
export interface CostingInput {
  orgId: string;
  costing: CostingLookup;
  movement: { productVariantId: number; locationId: number; lotId?: number | null };
  /** Signed, as it appears on the ledger row. */
  delta: string;
  unitCost: string | null;
  onHandBefore: string;
  averageCostBefore: string | null;
  allowNegativeStock: boolean;
  sourceType: string | null;
  sourceId: string;
}

/**
 * What a movement will cost, decided before the ledger row is written so the
 * row can carry its cost from birth. Discriminated, because an issue also
 * carries the layer draws it intends to make and a receipt has none.
 */
export type CostingPlan =
  | {
      kind: "receipt";
      costingMethod: CostingMethod;
      unitCost: string | null;
      totalCost: string | null;
    }
  | {
      kind: "issue";
      costingMethod: CostingMethod;
      issueInput: PlannedIssueInput;
      plan: IssuePlan;
      unitCost: string;
      totalCost: string;
    };

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
   * The cost of a movement, worked out *before* the fact row exists.
   *
   * A receipt already knows its own cost — it is on the movement. An issue does
   * not: its cost is whatever the layers it consumes turn out to be worth, and
   * that used to be discovered only after the ledger row had been inserted, so
   * the row was inserted with a null cost and UPDATEd a moment later. That one
   * UPDATE was the reason a posted movement had to stay writable.
   *
   * Planning the issue first removes the need. The layer locks this takes are
   * held by the surrounding transaction through `commit`, so no other command
   * can consume the layers in between.
   */
  async plan(tx: Tx, input: CostingInput): Promise<CostingPlan> {
    const { costingMethod, standardCost } = costingFor(
      input.costing,
      input.movement.productVariantId,
    );

    if (isPositive(input.delta)) {
      return {
        kind: "receipt",
        costingMethod,
        unitCost: input.unitCost,
        totalCost: input.unitCost ? mulDec(input.unitCost, input.delta) : null,
      };
    }

    const issueInput = this.issueInput(input, costingMethod, standardCost);
    const plan = await this.valuation.planIssue(tx, issueInput);
    return {
      kind: "issue",
      costingMethod,
      issueInput,
      plan,
      // Positive magnitudes, matching the receipt side: the sign lives on
      // quantity_change, and duplicating it in the cost would double-count it
      // in every valuation sum.
      unitCost: plan.unitCost,
      totalCost: plan.totalCost,
    };
  }

  /**
   * Records the cost side against the movement it belongs to, and returns the
   * variant's average cost after it. A receipt creates a layer (and, under
   * weighted average, a recorded recomputation); an issue writes the layer
   * consumption the plan chose, so COGS stays reproducible from the rows rather
   * than being an in-place decrement that leaves no trace.
   */
  async commit(
    tx: Tx,
    input: CostingInput,
    planned: CostingPlan,
    txnId: number,
  ): Promise<string | null> {
    if (planned.kind === "issue") {
      await this.valuation.commitIssue(tx, planned.issueInput, planned.plan, txnId);
      return input.averageCostBefore;
    }

    if (!input.unitCost) return input.averageCostBefore;
    return this.valuation.recordReceipt(tx, {
      orgId: input.orgId,
      productVariantId: input.movement.productVariantId,
      locationId: input.movement.locationId,
      lotId: input.movement.lotId ?? null,
      stockTransactionId: txnId,
      quantity: input.delta,
      unitCost: input.unitCost,
      costingMethod: planned.costingMethod,
      onHandBefore: input.onHandBefore,
      averageCostBefore: input.averageCostBefore,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
  }

  private issueInput(
    input: CostingInput,
    costingMethod: CostingMethod,
    standardCost: string | null,
  ): PlannedIssueInput {
    return {
      orgId: input.orgId,
      productVariantId: input.movement.productVariantId,
      locationId: input.movement.locationId,
      lotId: input.movement.lotId ?? null,
      quantity: mulDec(input.delta, "-1"),
      costingMethod,
      averageCost: input.averageCostBefore,
      standardCost,
      allowUncovered: input.allowNegativeStock,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    };
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
