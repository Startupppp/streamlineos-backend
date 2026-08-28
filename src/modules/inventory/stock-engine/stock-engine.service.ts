import { createHash } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invStockLevels, invStockTransactions, invIdempotencyKeys } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";
import { addDec, cmpDec, mulDec, isPositive, isNegative } from "./decimal";
import { ValuationService } from "./valuation.service";
import { WarehouseScopeService } from "./warehouse-scope.service";
import { claimIdempotencyKey, extractEngineResult } from "./idempotency";
import { lockLevels, levelKey } from "./stock-level-locks";
import { MovementCostingService } from "./movement-costing.service";
import { InventoryAccountingBridge } from "./accounting-bridge";
import { loadCostingContext } from "./costing-context";
import {
  INV_ERRORS,
  type StockMovement,
  type StockEngineCommand,
  type StockEngineResult,
  type ReverseCommand,
} from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { addDec, subDec, mulDec, divDec, cmpDec } from "./decimal";

type QuantityBucket = "ON_HAND" | "BLOCKED" | "QUALITY_HOLD";

/** The quantity the named bucket holds, for the ledger's before/after pair. */
function bucketQuantities(
  bucket: QuantityBucket,
  level: { onHand: string; blockedQty: string; qualityHoldQty: string },
): string {
  if (bucket === "BLOCKED") return level.blockedQty;
  if (bucket === "QUALITY_HOLD") return level.qualityHoldQty;
  return level.onHand;
}

/**
 * `blocked_qty` and `quality_hold_qty` are *subtracted from* `on_hand` by the
 * availability formula, which makes each a subset of on_hand rather than a
 * pool beside it. Two things follow, and neither was checked: a subset cannot
 * be negative (releasing more than is held), and a subset cannot exceed the
 * whole (holding more than is on the shelf, which drove available below zero
 * while on_hand itself stayed comfortably positive and passed the only guard
 * there was).
 *
 * The subset-vs-whole check is relaxed under `allowNegativeStock`, where a
 * negative on_hand is a deliberate backorder position and "subset of the
 * whole" stops meaning anything. A negative bucket is never legitimate, so
 * that one holds either way.
 */
function assertBucketsCoherent(
  next: { onHand: string; blockedQty: string; qualityHoldQty: string },
  allowNegativeStock: boolean,
): void {
  if (!allowNegativeStock && isNegative(next.onHand)) {
    throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
  }
  if (isNegative(next.blockedQty) || isNegative(next.qualityHoldQty)) {
    throw new BadRequestException({ code: INV_ERRORS.RELEASE_EXCEEDS_HELD });
  }
  if (
    !allowNegativeStock &&
    cmpDec(addDec(next.blockedQty, next.qualityHoldQty), next.onHand) > 0
  ) {
    throw new BadRequestException({ code: INV_ERRORS.HOLD_EXCEEDS_ON_HAND });
  }
}

/**
 * A2. The cost basis a movement inherits from an earlier one in the same
 * command, or null when it names none.
 *
 * Backward references only, and validated rather than assumed: a forward or
 * self reference would read an entry that has not been written yet, which
 * silently yields `undefined` and books the receipt at no cost at all.
 */
function resolveInheritedCost(
  movement: StockMovement,
  movementIndex: number,
  derivedUnitCost: ReadonlyArray<string | null>,
): string | null {
  const source = movement.costFromMovementIndex;
  if (source === undefined) return null;
  if (!Number.isInteger(source) || source < 0 || source >= movementIndex) {
    throw new BadRequestException({
      code: INV_ERRORS.INVALID_DOCUMENT_STATE,
      message: `Movement ${movementIndex} inherits its cost from movement ${source}, which is not an earlier movement in this command`,
    });
  }
  return derivedUnitCost[source] ?? null;
}

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
    private readonly periods: InventoryAccountingBridge,
    private readonly movementCosting: MovementCostingService,
  ) {}

  /**
   * Locations with no capacity recorded are unlimited, which is the common case
   * and must stay free. One aggregate covers every raised location; the HAVING
   * does the comparison in the database so a numeric never becomes a float on
   * the way to a decision.
   */
  private async assertLocationCapacity(
    tx: Tx,
    orgId: string,
    movements: StockEngineCommand["movements"],
  ): Promise<void> {
    const raised = [
      ...new Set(
        movements
          .filter(
            (m) =>
              (m.qualityBucket ?? "ON_HAND") === "ON_HAND" &&
              isPositive(m.quantityDelta),
          )
          .map((m) => m.locationId),
      ),
    ];
    if (raised.length === 0) return;

    const over = await tx.execute<{ id: number; code: string; capacity: string; total: string }>(sql`
      SELECT l.id, l.code, l.capacity::text AS capacity, COALESCE(SUM(sl.on_hand), 0)::text AS total
      FROM inv_locations l
      LEFT JOIN inv_stock_levels sl
        ON sl.org_id = l.org_id AND sl.location_id = l.id
      WHERE l.org_id = ${orgId}
        AND l.id IN (${sql.join(raised.map((id) => sql`${id}`), sql`, `)})
        AND l.capacity IS NOT NULL
      GROUP BY l.id, l.code, l.capacity
      HAVING COALESCE(SUM(sl.on_hand), 0) > l.capacity
    `);

    // A row with no capacity cannot be a violation. The HAVING clause already
    // guarantees that, so this is belt and braces against a caller handing back
    // rows this query did not shape.
    const breaches = over.filter((row) => row.capacity != null);
    if (breaches.length > 0) {
      const detail = breaches
        .map((row) => `${row.code} holds ${row.total} against a capacity of ${row.capacity}`)
        .join("; ");
      throw new BadRequestException({
        code: INV_ERRORS.LOCATION_CAPACITY_EXCEEDED,
        message: `Location capacity exceeded: ${detail}`,
      });
    }
  }

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
    await this.periods.assertOpen(orgId, postingDate);
    const costing = await loadCostingContext(
      tx,
      orgId,
      cmd.movements.map((m) => m.productVariantId),
      postingDate,
    );
    const txnIds: number[] = [];
    const levels: StockEngineResult["levels"] = [];
    const decreasedVariantIds = new Set<number>();

    // Every grain this command touches is locked in one ordered statement before
    // any of it is read, so two concurrent commands cannot take the same rows in
    // opposite order.
    const locked = await lockLevels(
      tx,
      orgId,
      cmd.movements.map((m) => ({
        productVariantId: m.productVariantId,
        locationId: m.locationId,
        lotId: m.lotId ?? null,
        serialId: m.serialId ?? null,
      })),
    );

    // A2. What each movement actually cost, so a later movement in the same
    // command can be received at the figure an earlier one turned out to
    // consume rather than at an estimate of it.
    const derivedUnitCost: Array<string | null> = [];

    for (const [movementIndex, movement] of cmd.movements.entries()) {
      const level = locked.get(
        levelKey({
          productVariantId: movement.productVariantId,
          locationId: movement.locationId,
          lotId: movement.lotId ?? null,
          serialId: movement.serialId ?? null,
        }),
      );

      if (!level)
        throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

      const bucket = movement.qualityBucket ?? "ON_HAND";
      const delta = movement.quantityDelta;
      const positive = isPositive(delta);

      const newOnHand =
        bucket === "ON_HAND" ? addDec(level.onHand, delta) : level.onHand;
      const newBlocked =
        bucket === "BLOCKED"
          ? addDec(level.blockedQty, delta)
          : level.blockedQty;
      const newQualityHold =
        bucket === "QUALITY_HOLD"
          ? addDec(level.qualityHoldQty, delta)
          : level.qualityHoldQty;

      assertBucketsCoherent(
        { onHand: newOnHand, blockedQty: newBlocked, qualityHoldQty: newQualityHold },
        settings.allowNegativeStock,
      );

      // before/after describe the bucket this movement actually moved. Recording
      // on-hand for a hold or block movement made after = before + change false
      // for those rows, so the ledger's own arithmetic could not be a constraint.
      const bucketBefore = bucketQuantities(bucket, level);
      const bucketAfter = bucketQuantities(bucket, {
        onHand: newOnHand,
        blockedQty: newBlocked,
        qualityHoldQty: newQualityHold,
      });

      // A2. The cost side is decided before the fact row is written, so the row
      // carries its cost from birth. It used to be inserted cost-less and
      // UPDATEd a moment later, which is the only reason this table had to stay
      // writable at all.
      const inheritedUnitCost = resolveInheritedCost(
        movement,
        movementIndex,
        derivedUnitCost,
      );
      const costingInput = {
        orgId,
        costing,
        movement,
        delta,
        unitCost: inheritedUnitCost ?? movement.unitCost ?? null,
        onHandBefore: level.onHand,
        averageCostBefore: level.averageCost,
        allowNegativeStock: settings.allowNegativeStock,
        sourceType: cmd.sourceType ?? null,
        sourceId: cmd.sourceId,
      };
      const planned =
        bucket === "ON_HAND" && !movement.settledCost
          ? await this.movementCosting.plan(tx, costingInput)
          : null;

      const unitCost = movement.settledCost
        ? movement.settledCost.unitCost
        : planned
          ? planned.unitCost
          : costingInput.unitCost;
      const totalCost = movement.settledCost
        ? movement.settledCost.totalCost
        : planned
          ? planned.totalCost
          : costingInput.unitCost && positive
            ? mulDec(costingInput.unitCost, delta)
            : null;
      derivedUnitCost[movementIndex] = unitCost;

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
          quantityBucket: bucket,
          quantityChange: delta,
          quantityBefore: bucketBefore,
          quantityAfter: bucketAfter,
          unitCost,
          totalCost,
          correctionOfTransactionId: movement.correctionOfTransactionId ?? null,
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

      let newAvgCost = level.averageCost;
      if (planned) {
        newAvgCost = await this.movementCosting.commit(
          tx,
          costingInput,
          planned,
          txnRow.id,
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

      // The snapshot is taken once, so a command with two movements over the
      // same grain must carry the first one's result forward or the second
      // reads a stale before-quantity and overwrites it.
      locked.set(levelKey(level), {
        ...level,
        onHand: newOnHand,
        blockedQty: newBlocked,
        qualityHoldQty: newQualityHold,
        averageCost: newAvgCost,
      });

      if (!positive && bucket === "ON_HAND") {
        decreasedVariantIds.add(movement.productVariantId);
      }

      levels.push({
        productVariantId: movement.productVariantId,
        locationId: movement.locationId,
        onHand: newOnHand,
      });
    }

    // INV-202. Same check as the batch path: capacity is a property of the
    // shelf and has to hold on whichever route a movement arrives by.
    await this.assertLocationCapacity(tx, orgId, cmd.movements);

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
      await this.periods.assertOpen(orgId, resolvePostingDate(commands[0]!));
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

        const derivedUnitCost: Array<string | null> = [];

        for (const [movementIndex, movement] of cmd.movements.entries()) {
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

          assertBucketsCoherent(
            { onHand: newOnHand, blockedQty: newBlocked, qualityHoldQty: newQualityHold },
            settings.allowNegativeStock,
          );

          const bucketBefore = bucketQuantities(bucket, state);
          const bucketAfter = bucketQuantities(bucket, {
            onHand: newOnHand,
            blockedQty: newBlocked,
            qualityHoldQty: newQualityHold,
          });

          // A2, as in executeInTx: cost decided before the fact row exists.
          const inheritedUnitCost = resolveInheritedCost(
            movement,
            movementIndex,
            derivedUnitCost,
          );
          const costingInput = {
            orgId,
            costing,
            movement,
            delta,
            unitCost: inheritedUnitCost ?? movement.unitCost ?? null,
            onHandBefore: state.onHand,
            averageCostBefore: state.averageCost,
            allowNegativeStock: settings.allowNegativeStock,
            sourceType: cmd.sourceType ?? null,
            sourceId: cmd.sourceId,
          };
          const planned =
            bucket === "ON_HAND" && !movement.settledCost
              ? await this.movementCosting.plan(tx, costingInput)
              : null;

          const unitCost = movement.settledCost
            ? movement.settledCost.unitCost
            : planned
              ? planned.unitCost
              : costingInput.unitCost;
          const totalCost = movement.settledCost
            ? movement.settledCost.totalCost
            : planned
              ? planned.totalCost
              : costingInput.unitCost && positive
                ? mulDec(costingInput.unitCost, delta)
                : null;
          derivedUnitCost[movementIndex] = unitCost;

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
              quantityBucket: bucket,
              quantityChange: delta,
              quantityBefore: bucketBefore,
              quantityAfter: bucketAfter,
              unitCost,
              totalCost,
              correctionOfTransactionId: movement.correctionOfTransactionId ?? null,
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
          if (planned) {
            newAvgCost = await this.movementCosting.commit(
              tx,
              costingInput,
              planned,
              txnRow.id,
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

        // INV-202. A bin's capacity was settable in the warehouse editor and
        // read by nothing, which made it decorative -- an operator could put a
        // pallet into a location the building has no room for and the system
        // would agree. Checked after the levels are written so it sees the
        // resulting position rather than a prediction of it, and only for
        // locations a movement actually raised: a capacity check on a location
        // stock just left is a query for no reason.
        await this.assertLocationCapacity(tx, orgId, cmd.movements);

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

    // A2. A posted movement may be corrected once. Reversing it twice unwinds it
    // twice, and the second unwind is stock that never existed — the idempotency
    // key stops a retry of the *same* request, not a second request to reverse
    // the same movement. This check is for a legible error; the partial unique
    // index on (org_id, correction_of_transaction_id) is what makes it true when
    // two reversals race, where a check on its own always loses.
    const existing = await tx
      .select({ id: invStockTransactions.id })
      .from(invStockTransactions)
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          eq(invStockTransactions.correctionOfTransactionId, original.id),
        ),
      )
      .limit(1);
    if (existing.length > 0)
      throw new BadRequestException({
        code: INV_ERRORS.INVALID_DOCUMENT_STATE,
        message: `Movement ${original.id} has already been reversed by movement ${existing[0]!.id}`,
      });

    // Unwind the layer this receipt created before posting the counter-movement.
    // Left to the ordinary issue path, the reversal would consume unrelated
    // older layers and leave the erroneous layer sitting in stock.
    //
    // A2. Unwinding it is only half the job, and the missing half was a live
    // defect: the compensating movement then went down the ordinary issue path
    // and tried to consume layers *again*. Where the reversed receipt was the
    // only coverage that raised "cost layers do not cover this issue" and the
    // reversal was impossible; where older layers existed it succeeded and took
    // the same value out of inventory twice. `settledCost` says the cost side is
    // already accounted for.
    let settledCost: { unitCost: string | null; totalCost: string | null } | undefined;
    if (isPositive(original.quantityChange)) {
      const unwound = await this.valuation.reverseReceiptLayer(tx, orgId, original.id);
      if (unwound) {
        settledCost = {
          unitCost: original.unitCost,
          totalCost:
            original.totalCost ??
            (original.unitCost
              ? mulDec(original.unitCost, original.quantityChange)
              : null),
        };
      }
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
          qualityBucket: original.quantityBucket,
          correctionOfTransactionId: original.id,
          ...(settledCost ? { settledCost } : {}),
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
