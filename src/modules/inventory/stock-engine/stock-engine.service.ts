import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  invStockLevels, invStockTransactions, invValuationLayers,
  invIdempotencyKeys, invProductVariants, invProducts,
} from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";
import { INV_ERRORS, type StockEngineCommand, type StockEngineResult, type ReverseCommand } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function parseScaled(s: string): bigint {
  const t = s.trim();
  const neg = t.startsWith("-");
  const body = neg || t.startsWith("+") ? t.slice(1) : t;
  const [intPart = "0", fracRaw = ""] = body.split(".");
  const frac5 = (fracRaw + "00000").slice(0, 5);
  let scaled = BigInt(intPart || "0") * 10000n + BigInt(frac5.slice(0, 4) || "0");
  if (Number(frac5[4]) >= 5) scaled += 1n;
  return neg ? -scaled : scaled;
}

function formatScaled(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10000n;
  const frac = (abs % 10000n).toString().padStart(4, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den === 0n) return 0n;
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return neg ? -rounded : rounded;
}

export function addDec(a: string, b: string): string { return formatScaled(parseScaled(a) + parseScaled(b)); }
export function mulDec(a: string, b: string): string { return formatScaled(divRoundHalfUp(parseScaled(a) * parseScaled(b), 10000n)); }
export function divDec(a: string, b: string): string { const bs = parseScaled(b); if (bs === 0n) return "0.0000"; return formatScaled(divRoundHalfUp(parseScaled(a) * 10000n, bs)); }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractEngineResult(stored: unknown): StockEngineResult {
  const transactionIds: number[] = [];
  const levels: StockEngineResult["levels"] = [];

  if (isPlainObject(stored)) {
    if (Array.isArray(stored.transactionIds)) {
      for (const id of stored.transactionIds) {
        if (typeof id === "number") transactionIds.push(id);
      }
    }
    if (Array.isArray(stored.levels)) {
      for (const l of stored.levels) {
        if (isPlainObject(l)) {
          levels.push({
            productVariantId: Number(l.productVariantId),
            locationId: Number(l.locationId),
            onHand: String(l.onHand ?? "0"),
          });
        }
      }
    }
  }

  return { transactionIds, levels };
}

@Injectable()
export class StockEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
    private readonly auditService: InventoryAuditService,
    private readonly cache: CacheService,
  ) {}

  async executeInTx(tx: Tx, orgId: string, userId: string, cmd: StockEngineCommand): Promise<StockEngineResult> {
    const requestHash = createHash("sha256").update(JSON.stringify(cmd)).digest("hex");
    const claim = await this.claimIdempotencyKey(tx, orgId, cmd.idempotencyKey, requestHash);
    if (claim.kind === "replay") {
      return extractEngineResult(claim.stored);
    }
    const settings = await this.settingsService.get(orgId);
    const txnIds: number[] = [];
    const levels: StockEngineResult["levels"] = [];
    const decreasedVariantIds = new Set<number>();

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
        await this.recordValuationLayer(tx, orgId, movement.productVariantId, txnRow.id, delta, unitCost, cmd.sourceType ?? null, cmd.sourceId);
      } else if (bucket === "ON_HAND" && !isPositive) {
        await this.consumeValuationLayers(tx, orgId, movement.productVariantId, delta);
      }

      await tx.update(invStockLevels).set({
        onHand: newOnHand,
        blockedQty: newBlocked,
        qualityHoldQty: newQualityHold,
        averageCost: newAvgCost,
      }).where(eq(invStockLevels.id, level.id));

      if (!isPositive && bucket === "ON_HAND") {
        decreasedVariantIds.add(movement.productVariantId);
      }

      levels.push({ productVariantId: movement.productVariantId, locationId: movement.locationId, onHand: newOnHand });
    }

    await this.auditService.insert(tx, {
      orgId, actorUserId: userId, action: "stock.movement",
      resourceType: cmd.sourceType, resourceId: cmd.sourceId,
      after: { transactionIds: txnIds },
    });

    if (decreasedVariantIds.size > 0) {
      const variantIds = Array.from(decreasedVariantIds);
      const variants = await tx.select({
        id: invProductVariants.id,
        reorderPoint: invProducts.reorderPoint,
      })
        .from(invProductVariants)
        .innerJoin(invProducts, eq(invProducts.id, invProductVariants.productId))
        .where(inArray(invProductVariants.id, variantIds));

      const onHandByVariant = new Map<number, string>();
      for (const level of levels) {
        if (decreasedVariantIds.has(level.productVariantId)) {
          onHandByVariant.set(level.productVariantId, level.onHand);
        }
      }

      for (const variant of variants) {
        const reorderPoint = parseFloat(variant.reorderPoint ?? "0");
        if (reorderPoint <= 0) continue;
        const onHand = parseFloat(onHandByVariant.get(variant.id) ?? "0");
        if (onHand <= reorderPoint) {
          await OutboxWriter.emit(tx, {
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "inv_product_variant",
            aggregateId: String(variant.id),
            aggregateVersion: Date.now(),
            eventType: "inventory.stock.low",
            payload: {
              productVariantId: variant.id,
              onHand: onHandByVariant.get(variant.id) ?? "0",
              reorderPoint: variant.reorderPoint,
              sourceType: cmd.sourceType,
              sourceId: cmd.sourceId,
            },
            occurredAt: new Date(),
          });
        }
      }
    }

    const engineResult: StockEngineResult = { transactionIds: txnIds, levels };
    const responsePayload: Record<string, unknown> = { ...engineResult };
    await tx.update(invIdempotencyKeys).set({ status: "COMPLETED", response: responsePayload })
      .where(and(eq(invIdempotencyKeys.orgId, orgId), eq(invIdempotencyKeys.idempotencyKey, cmd.idempotencyKey)));

    return engineResult;
  }

  async execute(orgId: string, userId: string, cmd: StockEngineCommand): Promise<StockEngineResult> {
    const result = await this.db.transaction((tx) => this.executeInTx(tx, orgId, userId, cmd));
    void this.invalidateCaches(orgId);
    return result;
  }

  async executeMany(orgId: string, userId: string, commands: StockEngineCommand[]): Promise<StockEngineResult[]> {
    if (commands.length === 0) return [];

    const batchResults = await this.db.transaction(async (tx) => {
      const requestHashes = commands.map(cmd =>
        createHash("sha256").update(JSON.stringify(cmd)).digest("hex")
      );

      const claims: Array<{ kind: "proceed" } | { kind: "replay"; stored: unknown }> = [];
      for (let i = 0; i < commands.length; i++) {
        claims.push(await this.claimIdempotencyKey(tx, orgId, commands[i]!.idempotencyKey, requestHashes[i]!));
      }

      const settings = await this.settingsService.get(orgId);

      type LevelKey = { productVariantId: number; locationId: number; lotId: number | null; serialId: number | null };
      const uniqueLevelKeys = new Map<string, LevelKey>();

      for (let i = 0; i < commands.length; i++) {
        if (claims[i]!.kind === "replay") continue;
        for (const m of commands[i]!.movements) {
          const k = `${m.productVariantId}:${m.locationId}:${m.lotId ?? null}:${m.serialId ?? null}`;
          if (!uniqueLevelKeys.has(k)) {
            uniqueLevelKeys.set(k, {
              productVariantId: m.productVariantId,
              locationId: m.locationId,
              lotId: m.lotId ?? null,
              serialId: m.serialId ?? null,
            });
          }
        }
      }

      for (const lk of uniqueLevelKeys.values()) {
        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: lk.productVariantId,
          locationId: lk.locationId,
          lotId: lk.lotId,
          serialId: lk.serialId,
          onHand: "0",
          committed: "0",
          onOrder: "0",
          blockedQty: "0",
          qualityHoldQty: "0",
          outgoingQty: "0",
        }).onConflictDoNothing();
      }

      type LockedRow = {
        id: number;
        product_variant_id: number;
        location_id: number;
        lot_id: number | null;
        serial_id: number | null;
        on_hand: string;
        committed: string;
        blocked_qty: string;
        quality_hold_qty: string;
        average_cost: string | null;
      };

      let lockedRows: LockedRow[] = [];

      if (uniqueLevelKeys.size > 0) {
        const keyList = Array.from(uniqueLevelKeys.values());
        const orParts = keyList.map(lk =>
          sql`(product_variant_id = ${lk.productVariantId} AND location_id = ${lk.locationId} AND (lot_id IS NOT DISTINCT FROM ${lk.lotId}) AND (serial_id IS NOT DISTINCT FROM ${lk.serialId}))`
        );
        const whereOr = sql.join(orParts, sql` OR `);

        lockedRows = await tx.execute<LockedRow>(sql`
          SELECT id, product_variant_id, location_id, lot_id, serial_id,
                 on_hand, committed, blocked_qty, quality_hold_qty, average_cost
          FROM inv_stock_levels
          WHERE org_id = ${orgId}
            AND (${whereOr})
          ORDER BY id
          FOR UPDATE
        `);
      }

      type LevelState = {
        id: number;
        onHand: string;
        committed: string;
        blockedQty: string;
        qualityHoldQty: string;
        averageCost: string | null;
      };

      const levelMap = new Map<string, LevelState>();
      for (const row of lockedRows) {
        const k = `${row.product_variant_id}:${row.location_id}:${row.lot_id ?? null}:${row.serial_id ?? null}`;
        levelMap.set(k, {
          id: row.id,
          onHand: row.on_hand,
          committed: row.committed,
          blockedQty: row.blocked_qty,
          qualityHoldQty: row.quality_hold_qty,
          averageCost: row.average_cost,
        });
      }

      const results: StockEngineResult[] = [];

      for (let i = 0; i < commands.length; i++) {
        const claim = claims[i]!;
        const cmd = commands[i]!;

        if (claim.kind === "replay") {
          results.push(extractEngineResult(claim.stored));
          continue;
        }

        const txnIds: number[] = [];
        const cmdLevels: StockEngineResult["levels"] = [];
        const decreasedVariantIds = new Set<number>();

        for (const movement of cmd.movements) {
          const levelKey = `${movement.productVariantId}:${movement.locationId}:${movement.lotId ?? null}:${movement.serialId ?? null}`;
          const state = levelMap.get(levelKey);
          if (!state) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

          const bucket = movement.qualityBucket ?? "ON_HAND";
          const delta = movement.quantityDelta;
          const isPositive = parseFloat(delta) > 0;

          const newOnHand = bucket === "ON_HAND" ? addDec(state.onHand, delta) : state.onHand;
          const newBlocked = bucket === "BLOCKED" ? addDec(state.blockedQty, delta) : state.blockedQty;
          const newQualityHold = bucket === "QUALITY_HOLD" ? addDec(state.qualityHoldQty, delta) : state.qualityHoldQty;

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
            quantityBefore: state.onHand,
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

          let newAvgCost = state.averageCost;
          if (bucket === "ON_HAND" && isPositive && unitCost) {
            newAvgCost = await this.updateWeightedAverage(
              tx, orgId, movement.productVariantId,
              state.onHand, state.averageCost,
              delta, unitCost,
            );
            await this.recordValuationLayer(
              tx, orgId, movement.productVariantId, txnRow.id,
              delta, unitCost, cmd.sourceType ?? null, cmd.sourceId,
            );
          } else if (bucket === "ON_HAND" && !isPositive) {
            await this.consumeValuationLayers(tx, orgId, movement.productVariantId, delta);
          }

          await tx.update(invStockLevels).set({
            onHand: newOnHand,
            blockedQty: newBlocked,
            qualityHoldQty: newQualityHold,
            averageCost: newAvgCost,
          }).where(eq(invStockLevels.id, state.id));

          levelMap.set(levelKey, {
            ...state,
            onHand: newOnHand,
            blockedQty: newBlocked,
            qualityHoldQty: newQualityHold,
            averageCost: newAvgCost,
          });

          if (!isPositive && bucket === "ON_HAND") {
            decreasedVariantIds.add(movement.productVariantId);
          }

          cmdLevels.push({
            productVariantId: movement.productVariantId,
            locationId: movement.locationId,
            onHand: newOnHand,
          });
        }

        await this.auditService.insert(tx, {
          orgId, actorUserId: userId, action: "stock.movement",
          resourceType: cmd.sourceType, resourceId: cmd.sourceId,
          after: { transactionIds: txnIds },
        });

        if (decreasedVariantIds.size > 0) {
          const variantIds = Array.from(decreasedVariantIds);
          const variants = await tx.select({
            id: invProductVariants.id,
            reorderPoint: invProducts.reorderPoint,
          })
            .from(invProductVariants)
            .innerJoin(invProducts, eq(invProducts.id, invProductVariants.productId))
            .where(inArray(invProductVariants.id, variantIds));

          const onHandByVariant = new Map<number, string>();
          for (const lvl of cmdLevels) {
            if (decreasedVariantIds.has(lvl.productVariantId)) {
              onHandByVariant.set(lvl.productVariantId, lvl.onHand);
            }
          }

          for (const variant of variants) {
            const reorderPoint = parseFloat(variant.reorderPoint ?? "0");
            if (reorderPoint <= 0) continue;
            const onHand = parseFloat(onHandByVariant.get(variant.id) ?? "0");
            if (onHand <= reorderPoint) {
              await OutboxWriter.emit(tx, {
                eventId: randomUUID(),
                organizationId: orgId,
                aggregateType: "inv_product_variant",
                aggregateId: String(variant.id),
                aggregateVersion: Date.now(),
                eventType: "inventory.stock.low",
                payload: {
                  productVariantId: variant.id,
                  onHand: onHandByVariant.get(variant.id) ?? "0",
                  reorderPoint: variant.reorderPoint,
                  sourceType: cmd.sourceType,
                  sourceId: cmd.sourceId,
                },
                occurredAt: new Date(),
              });
            }
          }
        }

        const engineResult: StockEngineResult = { transactionIds: txnIds, levels: cmdLevels };
        await tx.update(invIdempotencyKeys).set({
          status: "COMPLETED",
          response: { ...engineResult } as Record<string, unknown>,
        }).where(and(
          eq(invIdempotencyKeys.orgId, orgId),
          eq(invIdempotencyKeys.idempotencyKey, cmd.idempotencyKey),
        ));

        results.push(engineResult);
      }

      return results;
    });

    void this.invalidateCaches(orgId);
    return batchResults;
  }

  async reverseInTx(tx: Tx, orgId: string, userId: string, cmd: ReverseCommand): Promise<StockEngineResult> {
    const original = await tx.query.invStockTransactions.findFirst({
      where: and(eq(invStockTransactions.orgId, orgId), eq(invStockTransactions.id, cmd.stockTransactionId)),
    });
    if (!original) throw new BadRequestException({ code: INV_ERRORS.INVALID_DOCUMENT_STATE });

    const reversalKey = `reversal:${cmd.idempotencyKey}`;
    return this.executeInTx(tx, orgId, userId, {
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

  async reverse(orgId: string, userId: string, cmd: ReverseCommand): Promise<StockEngineResult> {
    const r = await this.db.transaction((tx) => this.reverseInTx(tx, orgId, userId, cmd));
    void this.invalidateCaches(orgId);
    return r;
  }

  private async claimIdempotencyKey(
    tx: Tx,
    orgId: string,
    key: string,
    requestHash: string,
  ): Promise<{ kind: "proceed" } | { kind: "replay"; stored: unknown }> {
    const now = Date.now();
    const expiresAt = new Date(now + 86_400_000);
    const leaseExpiresAt = new Date(now + 15 * 60 * 1000);
    try {
      await tx.insert(invIdempotencyKeys).values({
        orgId,
        idempotencyKey: key,
        requestHash,
        status: "IN_FLIGHT",
        expiresAt,
        leaseExpiresAt,
      });
      return { kind: "proceed" };
    } catch {
      const existing = await tx.query.invIdempotencyKeys.findFirst({
        where: and(eq(invIdempotencyKeys.orgId, orgId), eq(invIdempotencyKeys.idempotencyKey, key)),
      });
      if (!existing) throw new Error("Idempotency insert failed unexpectedly");

      if (existing.requestHash !== null && existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException(
          "This idempotency key was already used with a different request",
        );
      }

      if (existing.status === "COMPLETED") {
        return { kind: "replay", stored: existing.response };
      }

      const leaseLock = existing.leaseExpiresAt !== null
        ? eq(invIdempotencyKeys.leaseExpiresAt, existing.leaseExpiresAt)
        : isNull(invIdempotencyKeys.leaseExpiresAt);

      if (existing.status === "IN_FLIGHT") {
        if (existing.leaseExpiresAt !== null && existing.leaseExpiresAt > new Date()) {
          throw new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY });
        }
        const reclaimed = await tx
          .update(invIdempotencyKeys)
          .set({ status: "IN_FLIGHT", requestHash, expiresAt, leaseExpiresAt })
          .where(
            and(
              eq(invIdempotencyKeys.orgId, orgId),
              eq(invIdempotencyKeys.idempotencyKey, key),
              leaseLock,
            ),
          )
          .returning({ id: invIdempotencyKeys.id });
        if (reclaimed.length === 0) {
          throw new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY });
        }
        return { kind: "proceed" };
      }

      const reclaimed = await tx
        .update(invIdempotencyKeys)
        .set({ status: "IN_FLIGHT", requestHash, expiresAt, leaseExpiresAt })
        .where(
          and(
            eq(invIdempotencyKeys.orgId, orgId),
            eq(invIdempotencyKeys.idempotencyKey, key),
            leaseLock,
          ),
        )
        .returning({ id: invIdempotencyKeys.id });
      if (reclaimed.length === 0) {
        throw new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY });
      }
      return { kind: "proceed" };
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

  private async recordValuationLayer(tx: Tx, orgId: string, productVariantId: number, txnId: number, qty: string, unitCost: string, sourceType: string | null, sourceId: string): Promise<void> {
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

  private async consumeValuationLayers(tx: Tx, orgId: string, productVariantId: number, negDelta: string): Promise<void> {
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

  async invalidateCaches(orgId: string): Promise<void> {
    await Promise.allSettled([
      this.cache.invalidatePattern(CACHE_KEYS.invStockLevelPattern(orgId)),
      this.cache.invalidate(CACHE_KEYS.invDashboard(orgId)),
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
      this.cache.invalidate(CACHE_KEYS.invLowStock(orgId)),
      this.cache.invalidate(CACHE_KEYS.invReorderReport(orgId)),
    ]);
  }
}
