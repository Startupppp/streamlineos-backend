import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invStockLevels, invStockTransactions, invIdempotencyKeys } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";
import { addDec, mulDec, isPositive, isNegative } from "./decimal";
import { ValuationService } from "./valuation.service";
import { WarehouseScopeService } from "./warehouse-scope.service";
import { claimIdempotencyKey, extractEngineResult } from "./idempotency";
import { MovementCostingService } from "./movement-costing.service";
import { PeriodsService } from "../../accounting/gl/periods.service";
import { loadCostingContext } from "./costing-context";
import {
  INV_ERRORS,
  type StockEngineCommand,
  type StockEngineResult,
  type ReverseCommand,
} from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { addDec, subDec, mulDec, divDec, cmpDec } from "./decimal";

function resolvePostingDate(cmd: StockEngineCommand): string {
  return cmd.postingDate ?? new Date().toISOString().slice(0, 10);
}

@Injectable()
export class StockEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
    private readonly auditService: InventoryAuditService,
    private readonly cache: CacheService,
    private readonly valuation: ValuationService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly periods: PeriodsService,
    private readonly movementCosting: MovementCostingService,
  ) {}

  async executeInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    cmd: StockEngineCommand,
  ): Promise<StockEngineResult> {
    const requestHash = createHash("sha256")
      .update(JSON.stringify(cmd))
      .digest("hex");
    const claim = await claimIdempotencyKey(
      tx,
      orgId,
      cmd.idempotencyKey,
      requestHash,
    );
    if (claim.kind === "replay") {
      return extractEngineResult(claim.stored);
    }
    // One gate covers receipts, issues, transfers, adjustments and counts —
    // every stock mutation resolves to a location.
    await this.warehouseScope.assertLocationsInScope(
      tx, orgId, userId, cmd.movements.map((m) => m.locationId),
    );

    // A movement may not be posted into a closed or locked accounting period.
    // accounting_periods and this guard already existed; Inventory simply never
    // called them, so backdated stock could silently restate a reported month.
    const settings = await this.settingsService.get(orgId);
    const postingDate = resolvePostingDate(cmd);
    await this.periods.assertPeriodOpen(orgId, new Date(postingDate));
    const costing = await loadCostingContext(
      tx,
      orgId,
      cmd.movements.map((m) => m.productVariantId),
      postingDate,
    );
    const txnIds: number[] = [];
    const levels: StockEngineResult["levels"] = [];
    const decreasedVariantIds = new Set<number>();

    for (const movement of cmd.movements) {
      await tx
        .insert(invStockLevels)
        .values({
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
        })
        .onConflictDoNothing();

      const [level] = await tx.execute<{
        id: number;
        on_hand: string;
        committed: string;
        blocked_qty: string;
        quality_hold_qty: string;
        average_cost: string | null;
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

      if (!level)
        throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

      const bucket = movement.qualityBucket ?? "ON_HAND";
      const delta = movement.quantityDelta;
      const positive = isPositive(delta);

      const newOnHand =
        bucket === "ON_HAND" ? addDec(level.on_hand, delta) : level.on_hand;
      const newBlocked =
        bucket === "BLOCKED"
          ? addDec(level.blocked_qty ?? "0", delta)
          : (level.blocked_qty ?? "0");
      const newQualityHold =
        bucket === "QUALITY_HOLD"
          ? addDec(level.quality_hold_qty ?? "0", delta)
          : (level.quality_hold_qty ?? "0");

      if (!settings.allowNegativeStock && isNegative(newOnHand)) {
        throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
      }

      const unitCost = movement.unitCost ?? null;
      const totalCost = unitCost && positive ? mulDec(unitCost, delta) : null;

      const [txnRow] = await tx
        .insert(invStockTransactions)
        .values({
          orgId,
          productVariantId: movement.productVariantId,
          locationId: movement.locationId,
          lotId: movement.lotId ?? null,
          serialId: movement.serialId ?? null,
          transactionType:
            movement.transactionType as (typeof invStockTransactions.$inferInsert)["transactionType"],
          quantityChange: delta,
          quantityBefore: level.on_hand,
          quantityAfter: newOnHand,
          unitCost,
          totalCost,
          idempotencyKey: cmd.idempotencyKey,
          postingDate,
          reason: cmd.reason ?? null,
          referenceType: cmd.sourceType,
          referenceId: cmd.sourceId,
          metadata: null,
          notes: null,
          createdBy: userId,
        })
        .returning({ id: invStockTransactions.id });

      if (!txnRow) throw new Error("Failed to insert stock transaction");
      txnIds.push(txnRow.id);

      let newAvgCost = level.average_cost;
      if (bucket === "ON_HAND") {
        newAvgCost = await this.movementCosting.applyCosting(
          tx,
          orgId,
          costing,
          movement,
          txnRow.id,
          delta,
          unitCost,
          level.on_hand,
          level.average_cost,
          settings.allowNegativeStock,
          cmd.sourceType ?? null,
          cmd.sourceId,
        );
      }

      await tx
        .update(invStockLevels)
        .set({
          onHand: newOnHand,
          blockedQty: newBlocked,
          qualityHoldQty: newQualityHold,
          averageCost: newAvgCost,
        })
        .where(eq(invStockLevels.id, level.id));

      if (!positive && bucket === "ON_HAND") {
        decreasedVariantIds.add(movement.productVariantId);
      }

      levels.push({
        productVariantId: movement.productVariantId,
        locationId: movement.locationId,
        onHand: newOnHand,
      });
    }

    await this.auditService.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "stock.movement",
      resourceType: cmd.sourceType,
      resourceId: cmd.sourceId,
      after: { transactionIds: txnIds },
    });

    await this.movementCosting.emitLowStock(tx, orgId, decreasedVariantIds, levels, cmd.sourceType, cmd.sourceId);

    const engineResult: StockEngineResult = { transactionIds: txnIds, levels };
    const responsePayload: Record<string, unknown> = { ...engineResult };
    await tx
      .update(invIdempotencyKeys)
      .set({ status: "COMPLETED", response: responsePayload })
      .where(
        and(
          eq(invIdempotencyKeys.orgId, orgId),
          eq(invIdempotencyKeys.idempotencyKey, cmd.idempotencyKey),
        ),
      );

    return engineResult;
  }

  async execute(
    orgId: string,
    userId: string,
    cmd: StockEngineCommand,
  ): Promise<StockEngineResult> {
    const result = await this.db.transaction((tx) =>
      this.executeInTx(tx, orgId, userId, cmd),
    );
    void this.invalidateCaches(orgId);
    return result;
  }

  async executeMany(
    orgId: string,
    userId: string,
    commands: StockEngineCommand[],
  ): Promise<StockEngineResult[]> {
    if (commands.length === 0) return [];

    const batchResults = await this.db.transaction(async (tx) => {
      const requestHashes = commands.map((cmd) =>
        createHash("sha256").update(JSON.stringify(cmd)).digest("hex"),
      );

      const claims: Array<
        { kind: "proceed" } | { kind: "replay"; stored: unknown }
      > = [];
      for (let i = 0; i < commands.length; i++) {
        claims.push(
          await claimIdempotencyKey(
            tx,
            orgId,
            commands[i]!.idempotencyKey,
            requestHashes[i]!,
          ),
        );
      }

      await this.warehouseScope.assertLocationsInScope(
        tx, orgId, userId,
        commands.flatMap((c) => c.movements.map((m) => m.locationId)),
      );

      const settings = await this.settingsService.get(orgId);
      await this.periods.assertPeriodOpen(orgId, new Date(resolvePostingDate(commands[0]!)));
      const costing = await loadCostingContext(
        tx,
        orgId,
        commands.flatMap((c) => c.movements.map((m) => m.productVariantId)),
        resolvePostingDate(commands[0]!),
      );

      type LevelKey = {
        productVariantId: number;
        locationId: number;
        lotId: number | null;
        serialId: number | null;
      };
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
        await tx
          .insert(invStockLevels)
          .values({
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
          })
          .onConflictDoNothing();
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
        const orParts = keyList.map(
          (lk) =>
            sql`(product_variant_id = ${lk.productVariantId} AND location_id = ${lk.locationId} AND (lot_id IS NOT DISTINCT FROM ${lk.lotId}) AND (serial_id IS NOT DISTINCT FROM ${lk.serialId}))`,
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
          if (!state)
            throw new BadRequestException({
              code: INV_ERRORS.LOCATION_NOT_FOUND,
            });

          const bucket = movement.qualityBucket ?? "ON_HAND";
          const delta = movement.quantityDelta;
          const positive = isPositive(delta);
          const postingDate = resolvePostingDate(cmd);

          const newOnHand =
            bucket === "ON_HAND" ? addDec(state.onHand, delta) : state.onHand;
          const newBlocked =
            bucket === "BLOCKED"
              ? addDec(state.blockedQty, delta)
              : state.blockedQty;
          const newQualityHold =
            bucket === "QUALITY_HOLD"
              ? addDec(state.qualityHoldQty, delta)
              : state.qualityHoldQty;

          if (!settings.allowNegativeStock && isNegative(newOnHand)) {
            throw new BadRequestException({
              code: INV_ERRORS.INSUFFICIENT_STOCK,
            });
          }

          const unitCost = movement.unitCost ?? null;
          const totalCost =
            unitCost && positive ? mulDec(unitCost, delta) : null;

          const [txnRow] = await tx
            .insert(invStockTransactions)
            .values({
              orgId,
              productVariantId: movement.productVariantId,
              locationId: movement.locationId,
              lotId: movement.lotId ?? null,
              serialId: movement.serialId ?? null,
              transactionType:
                movement.transactionType as (typeof invStockTransactions.$inferInsert)["transactionType"],
              quantityChange: delta,
              quantityBefore: state.onHand,
              quantityAfter: newOnHand,
              unitCost,
              totalCost,
              idempotencyKey: cmd.idempotencyKey,
              postingDate,
              reason: cmd.reason ?? null,
              referenceType: cmd.sourceType,
              referenceId: cmd.sourceId,
              metadata: null,
              notes: null,
              createdBy: userId,
            })
            .returning({ id: invStockTransactions.id });

          if (!txnRow) throw new Error("Failed to insert stock transaction");
          txnIds.push(txnRow.id);

          let newAvgCost = state.averageCost;
          if (bucket === "ON_HAND") {
            newAvgCost = await this.movementCosting.applyCosting(
              tx,
              orgId,
              costing,
              movement,
              txnRow.id,
              delta,
              unitCost,
              state.onHand,
              state.averageCost,
              settings.allowNegativeStock,
              cmd.sourceType ?? null,
              cmd.sourceId,
            );
          }

          await tx
            .update(invStockLevels)
            .set({
              onHand: newOnHand,
              blockedQty: newBlocked,
              qualityHoldQty: newQualityHold,
              averageCost: newAvgCost,
            })
            .where(eq(invStockLevels.id, state.id));

          levelMap.set(levelKey, {
            ...state,
            onHand: newOnHand,
            blockedQty: newBlocked,
            qualityHoldQty: newQualityHold,
            averageCost: newAvgCost,
          });

          if (!positive && bucket === "ON_HAND") {
            decreasedVariantIds.add(movement.productVariantId);
          }

          cmdLevels.push({
            productVariantId: movement.productVariantId,
            locationId: movement.locationId,
            onHand: newOnHand,
          });
        }

        await this.auditService.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "stock.movement",
          resourceType: cmd.sourceType,
          resourceId: cmd.sourceId,
          after: { transactionIds: txnIds },
        });

        await this.movementCosting.emitLowStock(tx, orgId, decreasedVariantIds, cmdLevels, cmd.sourceType, cmd.sourceId);

        const engineResult: StockEngineResult = {
          transactionIds: txnIds,
          levels: cmdLevels,
        };
        await tx
          .update(invIdempotencyKeys)
          .set({
            status: "COMPLETED",
            response: { ...engineResult } as Record<string, unknown>,
          })
          .where(
            and(
              eq(invIdempotencyKeys.orgId, orgId),
              eq(invIdempotencyKeys.idempotencyKey, cmd.idempotencyKey),
            ),
          );

        results.push(engineResult);
      }

      return results;
    });

    void this.invalidateCaches(orgId);
    return batchResults;
  }

  async reverseInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    cmd: ReverseCommand,
  ): Promise<StockEngineResult> {
    const original = await tx.query.invStockTransactions.findFirst({
      where: and(
        eq(invStockTransactions.orgId, orgId),
        eq(invStockTransactions.id, cmd.stockTransactionId),
      ),
    });
    if (!original)
      throw new BadRequestException({
        code: INV_ERRORS.INVALID_DOCUMENT_STATE,
      });

    // Unwind the layer this receipt created before posting the counter-movement.
    // Left to the ordinary issue path, the reversal would consume unrelated
    // older layers and leave the erroneous layer sitting in stock.
    if (isPositive(original.quantityChange)) {
      await this.valuation.reverseReceiptLayer(tx, orgId, original.id);
    }

    const reversalKey = `reversal:${cmd.idempotencyKey}`;
    return this.executeInTx(tx, orgId, userId, {
      idempotencyKey: reversalKey,
      sourceType: "reversal",
      sourceId: String(cmd.stockTransactionId),
      reason: cmd.reason,
      postingDate: original.postingDate ?? undefined,
      movements: [
        {
          transactionType: original.transactionType,
          productVariantId: original.productVariantId,
          locationId: original.locationId!,
          lotId: original.lotId ?? undefined,
          serialId: original.serialId ?? undefined,
          quantityDelta: mulDec(original.quantityChange, "-1"),
          unitCost: original.unitCost ?? undefined,
        },
      ],
    });
  }

  async reverse(
    orgId: string,
    userId: string,
    cmd: ReverseCommand,
  ): Promise<StockEngineResult> {
    const r = await this.db.transaction((tx) =>
      this.reverseInTx(tx, orgId, userId, cmd),
    );
    void this.invalidateCaches(orgId);
    return r;
  }

  async invalidateCaches(orgId: string): Promise<void> {
    await Promise.allSettled([
      this.cache.invalidateNamespace(`inv:stock:levels:${orgId}`),
      this.cache.invalidateNamespace(`inv:traceability:${orgId}`),
      this.cache.invalidate(CACHE_KEYS.invDashboard(orgId)),
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
      this.cache.invalidate(CACHE_KEYS.invLowStock(orgId)),
      this.cache.invalidate(CACHE_KEYS.invReorderReport(orgId)),
    ]);
  }
}
