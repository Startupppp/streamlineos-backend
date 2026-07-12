import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  invStockLevels, invStockTransactions, invValuationLayers,
  invIdempotencyKeys, invProducts, invProductVariants,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";
import { INV_ERRORS, type StockEngineCommand, type StockEngineResult, type ReverseCommand } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function addDec(a: string, b: string): string {
  return (parseFloat(a) + parseFloat(b)).toFixed(4);
}

export function mulDec(a: string, b: string): string {
  return (parseFloat(a) * parseFloat(b)).toFixed(4);
}

export function divDec(a: string, b: string): string {
  const bv = parseFloat(b);
  if (bv === 0) return "0.0000";
  return (parseFloat(a) / bv).toFixed(4);
}

@Injectable()
export class StockEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
    private readonly auditService: InventoryAuditService,
    private readonly cache: CacheService,
  ) {}

  async execute(orgId: string, userId: string, cmd: StockEngineCommand): Promise<StockEngineResult> {
    const result = await this.db.transaction(async (tx) => {
      await this.claimIdempotencyKey(tx, orgId, cmd.idempotencyKey);
      const settings = await this.settingsService.get(orgId);
      const txnIds: number[] = [];
      const levels: StockEngineResult["levels"] = [];

      for (const movement of cmd.movements) {
        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: movement.productVariantId,
          locationId: movement.locationId,
          lotId: movement.lotId ?? null,
          serialId: movement.serialId ?? null,
          onHand: "0",
          committed: "0",
          onOrder: "0",
          blockedQty: "0",
          qualityHoldQty: "0",
          outgoingQty: "0",
        }).onConflictDoNothing();

        const [level] = await tx.execute<{
          id: number; on_hand: string; committed: string; blocked_qty: string;
          quality_hold_qty: string; average_cost: string | null;
        }>(sql`
          SELECT id, on_hand, committed, blocked_qty, quality_hold_qty, average_cost
          FROM inv_stock_levels
          WHERE org_id = ${orgId}
            AND product_variant_id = ${movement.productVariantId}
            AND location_id = ${movement.locationId}
            AND (lot_id IS NOT DISTINCT FROM ${movement.lotId ?? null})
            AND (serial_id IS NOT DISTINCT FROM ${movement.serialId ?? null})
          FOR UPDATE
        `);

        if (!level) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

        const bucket = movement.qualityBucket ?? "ON_HAND";
        const delta = movement.quantityDelta;
        const isPositive = parseFloat(delta) > 0;

        const newOnHand = bucket === "ON_HAND" ? addDec(level.on_hand, delta) : level.on_hand;
        const newBlocked = bucket === "BLOCKED" ? addDec(level.blocked_qty ?? "0", delta) : level.blocked_qty ?? "0";
        const newQualityHold = bucket === "QUALITY_HOLD" ? addDec(level.quality_hold_qty ?? "0", delta) : level.quality_hold_qty ?? "0";

        if (!settings.allowNegativeStock && parseFloat(newOnHand) < 0) {
          throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
        }

        const unitCost = movement.unitCost ?? null;
        const totalCost = unitCost && isPositive ? mulDec(unitCost, delta) : null;

        const [txnRow] = await tx.insert(invStockTransactions).values({
          orgId,
          productVariantId: movement.productVariantId,
          locationId: movement.locationId,
          lotId: movement.lotId ?? null,
          serialId: movement.serialId ?? null,
          transactionType: movement.transactionType as typeof invStockTransactions.$inferInsert["transactionType"],
          quantityChange: delta,
          quantityBefore: level.on_hand,
          quantityAfter: newOnHand,
          unitCost,
          totalCost,
          idempotencyKey: cmd.idempotencyKey,
          reason: cmd.reason ?? null,
          referenceType: cmd.sourceType,
          referenceId: cmd.sourceId,
          metadata: null,
          notes: null,
          createdBy: userId,
        }).returning({ id: invStockTransactions.id });

        if (!txnRow) throw new Error("Failed to insert stock transaction");
        txnIds.push(txnRow.id);

        let newAvgCost = level.average_cost;
        if (bucket === "ON_HAND" && isPositive && unitCost) {
          newAvgCost = await this.updateWeightedAverage(tx, orgId, movement.productVariantId, level.on_hand, level.average_cost, delta, unitCost);
          await this.recordValuationLayer(tx, orgId, movement.productVariantId, txnRow.id, delta, unitCost, "RECEIPT", cmd.sourceType ?? null, cmd.sourceId);
        } else if (bucket === "ON_HAND" && !isPositive) {
          await this.consumeValuationLayers(tx, orgId, movement.productVariantId, delta, userId);
        }

        await tx.update(invStockLevels).set({
          onHand: newOnHand,
          blockedQty: newBlocked,
          qualityHoldQty: newQualityHold,
          averageCost: newAvgCost,
        }).where(eq(invStockLevels.id, level.id));

        levels.push({ productVariantId: movement.productVariantId, locationId: movement.locationId, onHand: newOnHand });
      }

      await this.auditService.insert(tx, {
        orgId, actorUserId: userId, action: "stock.movement",
        resourceType: cmd.sourceType, resourceId: cmd.sourceId,
        after: { transactionIds: txnIds },
      });

      const engineResult: StockEngineResult = { transactionIds: txnIds, levels };
      const responsePayload: Record<string, unknown> = { ...engineResult };
      await tx.update(invIdempotencyKeys).set({ status: "COMPLETED", response: responsePayload })
        .where(and(eq(invIdempotencyKeys.orgId, orgId), eq(invIdempotencyKeys.idempotencyKey, cmd.idempotencyKey)));

      return engineResult;
    });

    void this.invalidateCaches(orgId);
    return result;
  }

  async reverse(orgId: string, userId: string, cmd: ReverseCommand): Promise<StockEngineResult> {
    const original = await this.db.query.invStockTransactions.findFirst({
      where: and(eq(invStockTransactions.orgId, orgId), eq(invStockTransactions.id, cmd.stockTransactionId)),
    });
    if (!original) throw new BadRequestException({ code: INV_ERRORS.INVALID_DOCUMENT_STATE });

    const reversalKey = `reversal:${cmd.idempotencyKey}`;
    return this.execute(orgId, userId, {
      idempotencyKey: reversalKey,
      sourceType: "reversal",
      sourceId: String(cmd.stockTransactionId),
      reason: cmd.reason,
      movements: [{
        transactionType: original.transactionType,
        productVariantId: original.productVariantId,
        locationId: original.locationId!,
        lotId: original.lotId ?? undefined,
        serialId: original.serialId ?? undefined,
        quantityDelta: mulDec(original.quantityChange, "-1"),
        unitCost: original.unitCost ?? undefined,
      }],
    });
  }

  private async claimIdempotencyKey(tx: Tx, orgId: string, key: string): Promise<void> {
    try {
      await tx.insert(invIdempotencyKeys).values({
        orgId,
        idempotencyKey: key,
        status: "IN_FLIGHT",
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    } catch {
      const existing = await tx.query.invIdempotencyKeys.findFirst({
        where: and(eq(invIdempotencyKeys.orgId, orgId), eq(invIdempotencyKeys.idempotencyKey, key)),
      });
      if (!existing) throw new Error("Idempotency insert failed unexpectedly");
      if (existing.status === "COMPLETED") throw Object.assign(new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY }), { idempotentResult: existing.response });
      throw new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY });
    }
  }

  private async updateWeightedAverage(tx: Tx, orgId: string, variantId: number, oldQty: string, oldAvg: string | null, inQty: string, inCost: string): Promise<string> {
    const oldQ = parseFloat(oldQty);
    const inQ = parseFloat(inQty);
    const oldA = parseFloat(oldAvg ?? "0");
    const totalQ = oldQ + inQ;
    if (totalQ <= 0) return inCost;
    return divDec(addDec(mulDec(String(oldQ), String(oldA)), mulDec(inQty, inCost)), String(totalQ));
  }

  private async recordValuationLayer(tx: Tx, orgId: string, productVariantId: number, txnId: number, qty: string, unitCost: string, _method: string, sourceType: string | null, sourceId: string): Promise<void> {
    const variant = await tx.query.invProductVariants.findFirst({
      where: eq(invProductVariants.id, productVariantId),
      with: { product: { columns: { costingMethod: true } } },
    });
    const method = variant?.product?.costingMethod ?? "WEIGHTED_AVERAGE";
    const total = mulDec(qty, unitCost);
    await tx.insert(invValuationLayers).values({
      orgId, productVariantId, stockTransactionId: txnId,
      quantity: qty, unitCost, totalValue: total,
      remainingQuantity: qty, remainingValue: total,
      costingMethod: method, sourceType, sourceId,
    });
  }

  private async consumeValuationLayers(tx: Tx, orgId: string, productVariantId: number, negDelta: string, _userId: string): Promise<void> {
    let remaining = Math.abs(parseFloat(negDelta));
    if (remaining <= 0) return;

    const layers = await tx.execute<{ id: number; remaining_quantity: string; unit_cost: string }>(sql`
      SELECT id, remaining_quantity, unit_cost
      FROM inv_valuation_layers
      WHERE org_id = ${orgId} AND product_variant_id = ${productVariantId}
        AND remaining_quantity::numeric > 0
      ORDER BY created_at ASC
      FOR UPDATE
    `);

    for (const layer of layers) {
      if (remaining <= 0) break;
      const layerQty = parseFloat(layer.remaining_quantity);
      const consume = Math.min(remaining, layerQty);
      const newRemaining = layerQty - consume;
      const newValue = mulDec(String(newRemaining), layer.unit_cost);
      await tx.update(invValuationLayers)
        .set({ remainingQuantity: String(newRemaining), remainingValue: newValue })
        .where(eq(invValuationLayers.id, layer.id));
      remaining -= consume;
    }
  }

  private async invalidateCaches(orgId: string): Promise<void> {
    await Promise.allSettled([
      this.cache.invalidatePattern(CACHE_KEYS.invStockLevelPattern(orgId)),
      this.cache.invalidate(CACHE_KEYS.invDashboard(orgId)),
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
      this.cache.invalidate(CACHE_KEYS.invLowStock(orgId)),
      this.cache.invalidate(CACHE_KEYS.invReorderReport(orgId)),
    ]);
  }
}
